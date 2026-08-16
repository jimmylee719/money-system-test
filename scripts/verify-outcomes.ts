/**
 * outcomes 三道鎖與 constraint 的實測驗證：`npm run l5:verify`
 *
 * 【重點：這張表僅系統可寫，人工不可改】（CLAUDE.md）
 * 它是 G1/G2/G3 的唯一依據。若能事後編輯，
 * 「把賠錢那幾筆刪掉」就沒有任何機制擋得住，整個評估就失去意義。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();

/** 探針用不可能出現的 pick_id（真實 pick_id 為正數且來自 daily_picks） */
const PROBE_PICK_ID_BASE = 900_000_000;

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
      ...(method === 'GET' ? {} : { Prefer: 'return=minimal' }),
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
    /* 非 JSON */
  }
  return { status: res.status, code, message, text: raw.slice(0, 200) };
}

const results: { name: string; passed: boolean; detail: string }[] = [];
function record(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✓' : '✗'} ${name}`);
  console.log(`    ${detail}\n`);
}

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
          (codeOk && msgOk ? '' : `　（預期 code=${expectCode}）`)
      : `⚠️ 沒有被擋下：HTTP ${res.status}`,
  );
}

async function expectAccepted(name: string, body: unknown): Promise<void> {
  const res = await call('POST', 'outcomes', body);
  record(
    name,
    res.status === 201,
    res.status === 201
      ? 'HTTP 201'
      : `⚠️ 對照組竟然失敗：HTTP ${res.status} [${res.code}] ${(res.message ?? res.text).slice(0, 150)}`,
  );
}

/** 查目前最大的探針 pick_id，避免重跑時撞唯一索引 */
async function nextProbePickId(): Promise<number> {
  const res = await fetch(
    `${config.url}/rest/v1/outcomes?pick_id=gte.${PROBE_PICK_ID_BASE}&select=pick_id&order=pick_id.desc&limit=1`,
    { headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` } },
  );
  if (!res.ok) {
    throw new Error(`查詢探針號失敗：HTTP ${res.status}`);
  }
  const rows = (await res.json()) as { pick_id: number }[];
  return Math.max(PROBE_PICK_ID_BASE, (rows[0]?.pick_id ?? PROBE_PICK_ID_BASE) + 1);
}

const PROBE_PICK_ID = await nextProbePickId();

function probeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pick_id: PROBE_PICK_ID,
    data_as_of: '2026-08-14',
    code: '__probe',
    market: 'TWSE',
    list_kind: 'watchlist',
    horizon: 5,
    exit_date: '2026-08-21',
    entry_price: 100,
    exit_price: 105,
    raw_return_pct: 5,
    adjusted_return_pct: 5,
    share_factor: 1,
    cash_dividend_per_share: 0,
    ex_right_count: 0,
    has_rights_issue: false,
    barrier_touched: null,
    barrier_touch_date: null,
    trading_days_used: 5,
    engine_version: 'probe',
    computed_at: new Date().toISOString(),
    ...overrides,
  };
}

console.log('=== outcomes append-only 驗證 ===\n');
console.log(`探針 pick_id = ${PROBE_PICK_ID}（真實 pick_id 遠小於此）\n`);

await expectAccepted('對照組：正常的觀察榜結果寫得進去', [probeRow()]);
if (results[0]?.passed !== true) {
  console.log('✗ 探針寫不進去，後續測試無意義。先確認 0010 migration 已執行。');
  process.exit(1);
}

// ── 鎖二：這是成績單，改不得也刪不得 ────────────────────────────────────────
await expectRejected(
  '事後修改報酬數字（UPDATE）',
  'PATCH',
  `outcomes?pick_id=eq.${PROBE_PICK_ID}`,
  { adjusted_return_pct: 99 },
  '42501',
  'permission denied',
);

await expectRejected(
  '刪掉賠錢的那幾筆（DELETE）',
  'DELETE',
  `outcomes?pick_id=eq.${PROBE_PICK_ID}`,
  undefined,
  '42501',
  'permission denied',
);

await expectRejected(
  '偽造 inserted_at',
  'POST',
  'outcomes',
  [probeRow({ horizon: 10, exit_date: '2026-08-28', trading_days_used: 10, inserted_at: '2020-01-01T00:00:00Z' })],
  '42501',
);
await expectAccepted('　└ 對照組：同一列拿掉 inserted_at 就寫得進去', [
  probeRow({ horizon: 10, exit_date: '2026-08-28', trading_days_used: 10 }),
]);

// ── 唯一索引 ────────────────────────────────────────────────────────────────
await expectRejected(
  '同一筆 pick 的同一個觀察期重複寫入',
  'POST',
  'outcomes',
  [probeRow({ adjusted_return_pct: -99 })],
  '23505',
  'outcomes_pick_horizon_uniq',
);

// ── constraint ──────────────────────────────────────────────────────────────
await expectRejected(
  '未定義的觀察期（只准 5/10/20）',
  'POST',
  'outcomes',
  [probeRow({ horizon: 7, trading_days_used: 7 })],
  '23514',
  'outcomes_horizon_check',
);

await expectRejected(
  'trading_days_used 與 horizon 不一致（算了一半就寫）',
  'POST',
  'outcomes',
  [probeRow({ horizon: 20, exit_date: '2026-09-11', trading_days_used: 3 })],
  '23514',
  'outcomes_trading_days_check',
);

await expectRejected(
  '出場日早於訊號日（時序顛倒）',
  'POST',
  'outcomes',
  [probeRow({ horizon: 20, exit_date: '2026-08-01', trading_days_used: 20 })],
  '23514',
  'outcomes_exit_after_signal_check',
);

await expectRejected(
  '觀察榜卻帶了屏障結果（研究紀錄沒有屏障）',
  'POST',
  'outcomes',
  [probeRow({ horizon: 20, exit_date: '2026-09-11', trading_days_used: 20, barrier_touched: 'stop' })],
  '23514',
  'outcomes_barrier_by_kind_check',
);

await expectRejected(
  '交易訊號卻沒有屏障結果',
  'POST',
  'outcomes',
  [
    probeRow({
      horizon: 20,
      exit_date: '2026-09-11',
      trading_days_used: 20,
      list_kind: 'trade_signal',
      barrier_touched: null,
    }),
  ],
  '23514',
  'outcomes_barrier_by_kind_check',
);

await expectRejected(
  '股數係數小於 1（配股只會讓股數變多，不會變少）',
  'POST',
  'outcomes',
  [probeRow({ horizon: 20, exit_date: '2026-09-11', trading_days_used: 20, share_factor: 0.5 })],
  '23514',
  'outcomes_share_factor_check',
);

await expectRejected(
  '回填 L0 開始累積之前的日期',
  'POST',
  'outcomes',
  [probeRow({ horizon: 20, data_as_of: '2020-01-01', exit_date: '2020-02-01', trading_days_used: 20 })],
  '23514',
  'outcomes_no_backfill_check',
);

// ── 匿名 ────────────────────────────────────────────────────────────────────
if (config.anonKey !== null) {
  const res = await fetch(`${config.url}/rest/v1/outcomes`, {
    method: 'POST',
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${config.anonKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify([probeRow({ horizon: 20, exit_date: '2026-09-11', trading_days_used: 20 })]),
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
console.log('✓ outcomes 三道鎖與 constraint 全部有效');
console.log(`  註：探針列永久留在表中（pick_id ≥ ${PROBE_PICK_ID_BASE}、code __probe）。`);
process.exit(0);
