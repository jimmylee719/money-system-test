/**
 * daily_picks 三道鎖的實測驗證：`npm run l1:verify-picks`
 *
 * 【刻意繞過程式端】直接打 PostgREST。程式可以被改（包括被我改），
 * 要證明的是「即使程式被繞過，資料庫仍然拒絕」。
 *
 * 【每項檢查都比對 SQLSTATE 與訊息】
 * 只看「有沒有被擋」不夠——被別的原因擋下來會造成假通過。
 *
 * 【探針列寫入後刪不掉，所以必須一眼可辨識】
 * daily_picks 是 append-only，驗證用的探針列會永久留著——那正是鎖有效的證明，
 * 但也代表它不能混進真實清單。做法是把探針的 revision 設在 900000 以上，
 * 真實清單一律 revision < 1000。下游查詢一律過濾 `revision.lt.1000`。
 * 不用「未來日期」之類的辦法，是因為 constraint 會先擋掉，反而測不到要測的東西。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();

const PROBE_DATE = '2026-08-14'; // L0 開始累積的第一天，constraint 的下界

/**
 * 探針專用的 revision（真實清單一律 < 1000）。
 *
 * ⚠️ 2026-08-16：原本用 `process.hrtime.bigint() % 90000` 取號，實測會撞號——
 *    Windows 計時器精度不足以保證兩次執行落在不同餘數，撞到就會誤報失敗。
 *    改為查目前最大的探針號 +1。
 */
async function nextProbeRevision(): Promise<number> {
  const res = await fetch(
    `${config.url}/rest/v1/daily_picks?revision=gte.900000&select=revision&order=revision.desc&limit=1`,
    {
      headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) {
    throw new Error(`查詢探針號失敗：HTTP ${res.status}`);
  }
  const rows = (await res.json()) as { revision: number }[];
  return Math.max(900_000, (rows[0]?.revision ?? 900_000) + 1);
}

const PROBE_REVISION = await nextProbeRevision();

interface ApiResponse {
  readonly status: number;
  readonly code: string | null;
  readonly message: string | null;
  readonly text: string;
}

async function call(method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const res = await fetch(`${config.url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await res.text();
  let code: string | null = null;
  let message: string | null = null;
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown };
    code = typeof parsed.code === 'string' ? parsed.code : null;
    message = typeof parsed.message === 'string' ? parsed.message : null;
  } catch {
    /* 非 JSON 回應 */
  }
  return { status: res.status, code, message, text: raw.slice(0, 200) };
}

const results: { name: string; passed: boolean; detail: string }[] = [];

function record(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✓' : '✗'} ${name}`);
  console.log(`    ${detail}\n`);
}

/**
 * 斷言被拒絕，且是被**指定的**那道守門擋下。
 *
 * `messageContains` 可省略。省略的時機只有一種：欄位級權限不足時
 * PostgREST 只回「permission denied for table …」，訊息不會指名是哪個欄位
 * （2026-08-16 實測）。那種情況改用對照組證明，見下方 expectAccepted。
 */
async function expectRejected(
  name: string,
  method: string,
  path: string,
  body: unknown,
  expectCode: string,
  messageContains?: string,
): Promise<void> {
  const res = await call(method, path, body);
  const rejected = res.status >= 400;
  const codeOk = res.code === expectCode;
  const msgOk = messageContains === undefined || (res.message ?? res.text).includes(messageContains);
  record(
    name,
    rejected && codeOk && msgOk,
    rejected
      ? `HTTP ${res.status} [${res.code}] ${(res.message ?? res.text).slice(0, 150)}` +
          (codeOk && msgOk
            ? ''
            : `　（預期 code=${expectCode}${messageContains === undefined ? '' : ` 且訊息含「${messageContains}」`}）`)
      : `⚠️ 沒有被擋下：HTTP ${res.status}`,
  );
}

/** 對照組：斷言**應該成功**。負面測試若缺對照組，就分不清是被哪道守門擋的。 */
async function expectAccepted(name: string, body: unknown): Promise<void> {
  const res = await call('POST', 'daily_picks', body);
  record(
    name,
    res.status === 201,
    res.status === 201
      ? 'HTTP 201'
      : `⚠️ 對照組竟然失敗：HTTP ${res.status} [${res.code}] ${(res.message ?? res.text).slice(0, 150)}`,
  );
}

function probeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: '00000000-0000-4000-8000-000000000000',
    revision: PROBE_REVISION,
    data_as_of: PROBE_DATE,
    signal_at: new Date().toISOString(),
    list_kind: 'watchlist',
    rank: 1,
    code: '__probe',
    market: 'TWSE',
    name: '守門驗證探針',
    price_at_push: 1,
    composite_score: 0.5,
    real_factor_count: 1,
    factor_scores: [],
    engine_version: 'probe',
    active_factors: [],
    inactive_factors: [],
    universe_size: 0,
    tradable_count: 0,
    ranked_count: 0,
    ...overrides,
  };
}

console.log('=== daily_picks append-only 三道鎖驗證 ===\n');
console.log(`探針 revision = ${PROBE_REVISION}（真實清單一律 < 1000，可辨識）\n`);

// ── 先寫一列探針，後面的負面測試都針對它 ────────────────────────────────────
const seeded = await call('POST', 'daily_picks', [probeRow()]);
record(
  '寫入探針列（正常 INSERT 應該成功）',
  seeded.status === 201,
  `HTTP ${seeded.status}${seeded.status === 201 ? '' : ` ${seeded.text}`}`,
);
if (seeded.status !== 201) {
  console.log('✗ 探針寫不進去，後續測試無意義。先確認 0006 migration 已執行。');
  process.exit(1);
}

// ── 鎖二：UPDATE / DELETE 權限已收回 ────────────────────────────────────────
await expectRejected(
  '改寫已推出去的推薦價（UPDATE）',
  'PATCH',
  `daily_picks?revision=eq.${PROBE_REVISION}`,
  { price_at_push: 999 },
  '42501',
  'permission denied',
);

await expectRejected(
  '刪除不好看的歷史紀錄（DELETE）',
  'DELETE',
  `daily_picks?revision=eq.${PROBE_REVISION}`,
  undefined,
  '42501',
  'permission denied',
);

// ── 欄位級權限：inserted_at / id 不可偽造 ──────────────────────────────────
//
// 【為什麼要用對照組，不能只看有沒有被擋】
// 2026-08-16 實測：欄位級 INSERT 權限不足時，PostgREST 只回
// 「permission denied for table daily_picks」，訊息**不會指名是哪個欄位**。
// 光看錯誤碼無法分辨是「inserted_at 沒權限」還是「整張表都寫不進去」。
// 故每個負面測試都配一組對照：同一列、同一個 rank，只差那一個欄位，
// 一個被擋、一個 201，才算真的證明是該欄位造成的。
await expectRejected(
  '偽造 inserted_at（宣稱這份清單是上週就產生的）',
  'POST',
  'daily_picks',
  [probeRow({ rank: 2, inserted_at: '2020-01-01T00:00:00Z' })],
  '42501',
);
await expectAccepted('　└ 對照組：同一列拿掉 inserted_at 就寫得進去', [probeRow({ rank: 2 })]);

// id 擋在更前面：`generated always as identity` 是欄位定義層級的限制，
// 連權限都不必查就先拒絕，錯誤碼是 428C9 而不是 42501（2026-08-16 實測）。
await expectRejected(
  '偽造 id（自行指定主鍵）',
  'POST',
  'daily_picks',
  [probeRow({ rank: 3, id: 999_999_999 })],
  '428C9',
  'cannot insert a non-DEFAULT value into column "id"',
);
await expectAccepted('　└ 對照組：同一列拿掉 id 就寫得進去', [probeRow({ rank: 3 })]);

// ── 唯一索引：同一天同一 revision 不得重複出榜 ──────────────────────────────
await expectRejected(
  '同一天同一 revision 重複寫入同一名次（悄悄換掉今天的第 1 名）',
  'POST',
  'daily_picks',
  [probeRow({ code: '__probe2' })],
  '23505',
  'daily_picks_slot_uniq',
);

// ── constraint：資料本身要合理 ──────────────────────────────────────────────
await expectRejected(
  '合成分數超出 0～1',
  'POST',
  'daily_picks',
  [probeRow({ rank: 4, composite_score: 1.5 })],
  '23514',
  'daily_picks_score_range_check',
);

await expectRejected(
  '真實因子數為 0（全靠補值的股票不得上榜）',
  'POST',
  'daily_picks',
  [probeRow({ rank: 5, real_factor_count: 0 })],
  '23514',
  'daily_picks_real_factor_check',
);

await expectRejected(
  '回填 L0 開始累積之前的日期',
  'POST',
  'daily_picks',
  [probeRow({ rank: 6, data_as_of: '2020-01-01' })],
  '23514',
  'daily_picks_no_backfill_check',
);

await expectRejected(
  '未定義的清單種類（既不是觀察榜也不是交易訊號）',
  'POST',
  'daily_picks',
  [probeRow({ rank: 7, list_kind: 'buy_now' })],
  '23514',
  'daily_picks_list_kind_check',
);

// ── 匿名身分完全寫不進去 ────────────────────────────────────────────────────
if (config.anonKey !== null) {
  const res = await fetch(`${config.url}/rest/v1/daily_picks`, {
    method: 'POST',
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${config.anonKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify([probeRow({ rank: 8 })]),
    signal: AbortSignal.timeout(30_000),
  });
  record(
    '匿名金鑰寫入（鎖一 RLS）',
    res.status >= 400,
    `HTTP ${res.status}${res.status >= 400 ? '' : ' ⚠️ 匿名竟然寫得進去'}`,
  );
} else {
  record('匿名金鑰寫入（鎖一 RLS）', false, '未提供 NEXT_PUBLIC_SUPABASE_ANON_KEY，無法驗證');
}

console.log('='.repeat(64));
const failed = results.filter((r) => !r.passed);
console.log(`${results.length - failed.length}/${results.length} 通過`);
if (failed.length > 0) {
  for (const f of failed) {
    console.log(`  ✗ ${f.name}：${f.detail}`);
  }
  process.exit(1);
}
console.log('✓ daily_picks 三道鎖與 constraint 全部有效');
console.log(`  註：探針列（revision ${PROBE_REVISION}、code __probe）永久留在表中，`);
console.log('      這正是 append-only 的證明。查真實清單請過濾 revision < 1000。');
process.exit(0);
