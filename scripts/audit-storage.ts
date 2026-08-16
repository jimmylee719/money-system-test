/**
 * 儲存層稽核與容量監控：`npm run l0:audit`
 *
 * 【一、容量監控】
 * 目的不是省空間，是**知道什麼時候必須行動**。
 * 依實測的每日增量推算剩餘天數，接近門檻時提前警告，屆時搬 Cloudflare R2
 * （免費 10 GB）即可 —— 而不是刪掉抓不回來的歷史資料。
 *
 * 【二、完整性稽核】
 * 2026-08-16 實測確認：service_role 可以刪除 Supabase Storage 物件，
 * 而 Storage 沒有資料表那種可上觸發器的機制 —— 儲存層的 append-only 無法「預防」。
 * 但帳本（raw_snapshots）是真正不可變的且存有 content_hash，
 * 所以**預防做不到，偵測必須做到**：逐列比對帳本與實際物件。
 *
 * 預設只驗證最新 100 個物件（免費方案 egress 5 GB/月，全驗會隨資料量線性消耗）。
 * 設 L0_AUDIT_ALL=1 可強制全驗。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { sha256Hex } from '../src/lib/l0/snapshot';
import { SupabaseStorageBodyStore } from '../src/lib/l0/supabase-storage';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();

const store = new SupabaseStorageBodyStore({
  url: config.url,
  apiKey: config.serviceRoleKey,
});

/** Supabase 免費方案 file storage 上限（官方 pricing 頁 2026-08-16 查證） */
const FREE_TIER_BYTES = 1024 * 1024 * 1024;
/** 剩餘低於這個天數就該開始準備搬 R2 */
const WARN_DAYS_REMAINING = 180;
/** 預設驗證的物件數（最新優先）。設 L0_AUDIT_ALL=1 全驗。 */
const DEFAULT_VERIFY_LIMIT = 100;

interface LedgerRow {
  readonly id: number;
  readonly source_id: string;
  readonly data_as_of: string | null;
  readonly content_hash: string;
  readonly content_length: number;
  readonly body_store: string;
  readonly body_path: string | null;
  readonly body_bytes: number | null;
}

const BASE_COLUMNS = 'id,source_id,data_as_of,content_hash,content_length,body_store,body_path';

async function fetchPage(columns: string, offset: number, pageSize: number): Promise<Response> {
  return fetch(
    `${config.url}/rest/v1/raw_snapshots?select=${columns}` +
      `&order=id.asc&limit=${pageSize}&offset=${offset}`,
    {
      headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
      signal: AbortSignal.timeout(60_000),
    },
  );
}

/**
 * 讀取帳本。
 *
 * body_bytes 是 0005 migration 才加的欄位。若尚未執行（例如 Supabase 控制平面
 * 故障導致無法跑 SQL），這裡會退回不含該欄位的查詢，容量統計改由 Storage 的
 * info 端點取得大小 —— 慢一些，但不會因為一個選配欄位就整支工具失效。
 */
async function fetchAllRows(): Promise<{ rows: LedgerRow[]; hasBodyBytes: boolean }> {
  const probe = await fetchPage(`${BASE_COLUMNS},body_bytes`, 0, 1);
  let hasBodyBytes = true;
  if (!probe.ok) {
    const text = await probe.text();
    if (!text.includes('body_bytes')) {
      throw new Error(`讀取帳本失敗：HTTP ${probe.status} ${text.slice(0, 200)}`);
    }
    hasBodyBytes = false;
    console.log('⚠ 帳本尚無 body_bytes 欄位（0005 migration 未執行）。');
    console.log('  容量統計改用 Storage info 端點逐檔查詢大小 —— 只取中繼資料，不消耗 egress。\n');
  }

  const columns = hasBodyBytes ? `${BASE_COLUMNS},body_bytes` : BASE_COLUMNS;
  const rows: LedgerRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetchPage(columns, offset, pageSize);
    if (!res.ok) {
      throw new Error(`讀取帳本失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const page = (await res.json()) as LedgerRow[];
    rows.push(...page.map((r) => ({ ...r, body_bytes: r.body_bytes ?? null })));
    if (page.length < pageSize) {
      return { rows, hasBodyBytes };
    }
  }
}

const mb = (n: number): string => (n / 1024 / 1024).toFixed(2);

const { rows } = await fetchAllRows();
const cloudRows = rows.filter((r) => r.body_store === 'supabase_storage' && r.body_path !== null);

// 同一份內容可能被多列帳本引用（同內容重複抓取），空間只佔一次
const byPath = new Map<string, LedgerRow[]>();
for (const row of cloudRows) {
  const key = row.body_path ?? '';
  byPath.set(key, [...(byPath.get(key) ?? []), row]);
}

console.log('=== L0 儲存層稽核 ===');
console.log(`帳本 ${rows.length} 列，其中 supabase_storage ${cloudRows.length} 列，`);
console.log(`相異物件 ${byPath.size} 個（重複抓取的相同內容只佔一次空間）\n`);

// ── 一、容量監控 ─────────────────────────────────────────────────────────────
console.log('--- 容量 ---');

let usedBytes = 0;
let unknownSize = 0;
let lookedUp = 0;
/** data_as_of 為 null 的來源（如 twse_margin_balance）佔用的空間 */
let undatedBytes = 0;
const bytesByDataDay = new Map<string, number>();

for (const [objectPath, refs] of byPath) {
  const row = refs[0];
  if (row === undefined) {
    continue;
  }
  // 帳本沒有大小就向 Storage 問（只取中繼資料，不下載內容）
  let bytes = row.body_bytes;
  if (bytes === null) {
    bytes = await store.size(objectPath);
    if (bytes !== null) {
      lookedUp += 1;
    }
  }
  if (bytes === null) {
    unknownSize += 1;
    continue;
  }
  usedBytes += bytes;
  if (row.data_as_of === null) {
    undatedBytes += bytes;
  } else {
    bytesByDataDay.set(row.data_as_of, (bytesByDataDay.get(row.data_as_of) ?? 0) + bytes);
  }
}

const dataDays = bytesByDataDay.size;
const datedBytes = [...bytesByDataDay.values()].reduce((a, b) => a + b, 0);
console.log(`已用       ：${mb(usedBytes)} MB / ${mb(FREE_TIER_BYTES)} MB（${((usedBytes / FREE_TIER_BYTES) * 100).toFixed(2)}%）`);
if (lookedUp > 0) {
  console.log(`（其中 ${lookedUp} 個物件的大小是即時向 Storage 查詢的；跑完 0005 後改由帳本直接提供，更快）`);
}
if (unknownSize > 0) {
  console.log(`大小未知   ：${unknownSize} 個物件（查詢失敗，不計入推算）`);
}

if (dataDays === 0) {
  console.log('資料天數   ：0，無法推算增量');
} else {
  // 只用「有日期的」位元組除以資料天數。把無日期來源攤進去會高估每日增量。
  const dailyRate = datedBytes / dataDays;
  const remainingDays = Math.floor((FREE_TIER_BYTES - usedBytes) / dailyRate);
  // 台股一年約 250 個交易日
  const remainingYears = remainingDays / 250;

  console.log(`資料天數   ：${dataDays} 天（相異 data_as_of）`);
  if (undatedBytes > 0) {
    console.log(`無日期來源 ：${mb(undatedBytes)} MB（payload 未宣告日期者，不計入每日增量）`);
  }
  console.log(`每日增量   ：${mb(dailyRate)} MB／資料日（實測，非估計）`);
  console.log(`剩餘容量   ：約 ${remainingDays} 個資料日 ≈ ${remainingYears.toFixed(1)} 年（以每年 250 交易日計）`);

  if (dataDays < 20) {
    console.log(`⚠ 樣本僅 ${dataDays} 天，推算誤差大。累積約 20 個交易日後數字才穩定。`);
  }
  if (remainingDays < WARN_DAYS_REMAINING) {
    console.log(`\n🔴 剩餘不足 ${WARN_DAYS_REMAINING} 個資料日，該準備搬 Cloudflare R2（免費 10 GB）。`);
    console.log('   ⚠️ 不要刪除歷史資料：交易所 OpenAPI 只提供最新一日，刪掉的永遠抓不回來，');
    console.log('      且 P5 因子檢定（Purged K-Fold CV + DSR）需要數年歷史才可能通過 t > 3.0。');
  }
}

// ── 二、完整性稽核 ───────────────────────────────────────────────────────────
const verifyAll = process.env['L0_AUDIT_ALL'] === '1';
const paths = [...byPath.keys()].sort().reverse(); // 新的在前（路徑含日期）
const toVerify = verifyAll ? paths : paths.slice(0, DEFAULT_VERIFY_LIMIT);

console.log('\n--- 完整性（下載 → 解壓 → 重算 SHA-256）---');
console.log(
  verifyAll
    ? `全部 ${toVerify.length} 個物件`
    : `最新 ${toVerify.length} / ${paths.length} 個物件（設 L0_AUDIT_ALL=1 可全驗；免費方案 egress 5 GB/月）`,
);

const missing: LedgerRow[] = [];
const mismatched: LedgerRow[] = [];
let verified = 0;

for (const objectPath of toVerify) {
  const refs = byPath.get(objectPath) ?? [];
  const row = refs[0];
  if (row === undefined) {
    continue;
  }
  try {
    const bytes = await store.get(objectPath);
    if (sha256Hex(bytes) === row.content_hash && bytes.byteLength === row.content_length) {
      verified += 1;
    } else {
      mismatched.push(row);
      console.log(`✗ 雜湊或長度不符：${objectPath}`);
    }
  } catch (error) {
    missing.push(row);
    console.log(`✗ 物件不存在或無法讀取：${objectPath}`);
    console.log(`    ${String(error).slice(0, 200)}`);
  }
}

console.log('');
console.log('='.repeat(64));
console.log(`完整性：相符 ${verified}｜遺失 ${missing.length}｜毀損 ${mismatched.length}`);

if (missing.length > 0 || mismatched.length > 0) {
  console.log('\n🔴 這是資料事故，不是警告。');
  console.log('   交易所 OpenAPI 只提供最新一日，遺失的原始資料無法重建。');
  for (const r of [...missing, ...mismatched]) {
    console.log(`   id=${r.id} ${r.source_id} data_as_of=${r.data_as_of} ${r.body_path}`);
  }
  process.exit(1);
}

console.log('✓ 帳本與儲存層一致');
process.exit(0);
