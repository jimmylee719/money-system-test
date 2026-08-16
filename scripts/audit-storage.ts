/**
 * 儲存層稽核：`npm run l0:audit`
 *
 * 【為什麼一定要有這支】
 * 2026-08-16 實測確認：service_role 可以刪除 Supabase Storage 的物件，
 * 而 Storage 沒有資料表那種可上觸發器的機制 —— 儲存層的 append-only 無法「預防」。
 *
 * 但帳本（raw_snapshots）是真正不可變的（三道鎖已實測），且每列都存有
 * 原始 bytes 的 content_hash。因此：**預防做不到，偵測必須做到**。
 *
 * 本工具逐列比對帳本與實際物件：
 *   物件不存在  → 資料遺失
 *   雜湊不相符  → 資料被竄改或毀損
 * 兩者皆為必須立即處理的事故（CLAUDE.md 停止條件）。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { SupabaseStorageBodyStore } from '../src/lib/l0/supabase-storage';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();

const store = new SupabaseStorageBodyStore({
  url: config.url,
  apiKey: config.serviceRoleKey,
});

interface LedgerRow {
  readonly id: number;
  readonly source_id: string;
  readonly data_as_of: string | null;
  readonly content_hash: string;
  readonly content_length: number;
  readonly body_store: string;
  readonly body_path: string | null;
}

const res = await fetch(
  `${config.url}/rest/v1/raw_snapshots` +
    '?select=id,source_id,data_as_of,content_hash,content_length,body_store,body_path' +
    '&order=id.asc',
  {
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
    signal: AbortSignal.timeout(60_000),
  },
);
if (!res.ok) {
  console.error(`讀取帳本失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}
const rows = (await res.json()) as LedgerRow[];

const cloudRows = rows.filter((r) => r.body_store === 'supabase_storage' && r.body_path !== null);
const skipped = rows.length - cloudRows.length;

console.log('=== L0 儲存層稽核（帳本 vs 實際物件）===');
console.log(`帳本共 ${rows.length} 列，其中 supabase_storage ${cloudRows.length} 列，略過 ${skipped} 列（本機檔案或無路徑）\n`);

// 同一份內容可能被多列帳本引用（同內容重複抓取），只需驗證一次
const byPath = new Map<string, LedgerRow[]>();
for (const row of cloudRows) {
  const list = byPath.get(row.body_path ?? '') ?? [];
  list.push(row);
  byPath.set(row.body_path ?? '', list);
}

const missing: LedgerRow[] = [];
const mismatched: LedgerRow[] = [];
let ok = 0;

for (const [objectPath, refs] of byPath) {
  const row = refs[0];
  if (row === undefined) {
    continue;
  }
  try {
    const bytes = await store.get(objectPath);
    const { sha256Hex } = await import('../src/lib/l0/snapshot');
    if (sha256Hex(bytes) === row.content_hash && bytes.byteLength === row.content_length) {
      ok += refs.length;
    } else {
      mismatched.push(...refs);
      console.log(`✗ 雜湊或長度不符：${objectPath}`);
    }
  } catch (error) {
    missing.push(...refs);
    console.log(`✗ 物件不存在或無法讀取：${objectPath}`);
    console.log(`    ${String(error).slice(0, 200)}`);
  }
}

console.log('');
console.log('='.repeat(60));
console.log(`相符 ${ok} 列｜遺失 ${missing.length} 列｜毀損 ${mismatched.length} 列`);

if (missing.length > 0 || mismatched.length > 0) {
  console.log('\n🔴 這是資料事故，不是警告。原始資料一旦遺失無法重建');
  console.log('   （交易所 OpenAPI 只提供最新一日，過去的抓不回來）。');
  for (const r of [...missing, ...mismatched]) {
    console.log(`   id=${r.id} ${r.source_id} data_as_of=${r.data_as_of} ${r.body_path}`);
  }
  process.exit(1);
}

console.log('✓ 帳本與儲存層完全一致');
process.exit(0);
