/**
 * L3 風控守門的實測驗證：`npm run l3:verify`
 *
 * 驗證兩件事：
 *   1. risk_config 的三道鎖（改不掉、刪不掉、時間戳偽造不了）
 *   2. daily_picks 的交易訊號 constraint —— 這是 P7 最重要的守門：
 *      **沒有停損價的東西不准被寫成「交易訊號」**，
 *      而觀察榜也不准偷帶屏障欄位假裝成可執行訊號。
 *
 * 【刻意繞過程式端】直接打 PostgREST，證明即使程式被繞過資料庫仍然拒絕。
 * 【每個負面測試都配對照組】欄位級權限不足時 PostgREST 不指名欄位，
 *   只差一個欄位、一擋一過，才算真的證明。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { ACTIVE_RISK_CONFIG } from '../src/lib/l3/config';
import { hashRiskConfig } from '../src/lib/l3/lock';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();

const PROBE_DATE = '2026-08-14';
const PROBE_RUN = '00000000-0000-4000-8000-000000000003';

/**
 * 探針用的 revision（真實清單一律 < 1000）。
 *
 * ⚠️ 2026-08-16：原本用 `process.hrtime.bigint() % 90000` 取號，實測會撞號——
 *    Windows 的計時器精度不足以保證兩次執行落在不同餘數，
 *    結果對照組被唯一索引擋下而誤報失敗。
 *    改為查目前最大的探針號 +1，確定不重複。
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
      // ⚠️ `return=minimal` 只能給寫入用。2026-08-16 實測：加在 GET 上會讓
      //    PostgREST 回空 body，於是「已登記的設定」被讀成「查無」——
      //    幸好方向是安全的（誤報未登記而非誤報一致），但仍是假結果。
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

async function expectAccepted(name: string, path: string, body: unknown): Promise<void> {
  const res = await call('POST', path, body);
  record(
    name,
    res.status === 201,
    res.status === 201
      ? 'HTTP 201'
      : `⚠️ 對照組竟然失敗：HTTP ${res.status} [${res.code}] ${(res.message ?? res.text).slice(0, 150)}`,
  );
}

/** 一列合法的交易訊號，後面的負面測試都從它變形而來 */
function signalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: PROBE_RUN,
    revision: PROBE_REVISION,
    data_as_of: PROBE_DATE,
    signal_at: new Date().toISOString(),
    list_kind: 'trade_signal',
    rank: 1,
    code: '__probe',
    market: 'TWSE',
    name: '風控驗證探針',
    price_at_push: 20,
    composite_score: 0.5,
    real_factor_count: 1,
    factor_scores: [],
    engine_version: 'probe',
    active_factors: [],
    inactive_factors: [],
    universe_size: 0,
    tradable_count: 0,
    ranked_count: 0,
    // L3 欄位
    entry_price: 20,
    stop_price: 18.5,
    take_profit_price: 23,
    time_exit_days: 10,
    lots: 7,
    shares: 7000,
    position_value_twd: 140000,
    risk_amount_twd: 10000,
    sigma_daily: 0.01,
    vol_observations: 25,
    equity_at_signal_twd: 1000000,
    risk_config_version: 'probe',
    risk_config_hash: 'f'.repeat(64),
    ...overrides,
  };
}

const PROBE_REVISION = await nextProbeRevision();

console.log('=== L3 風控守門驗證 ===\n');
console.log(`探針 revision = ${PROBE_REVISION}（真實清單一律 < 1000）\n`);

/**
 * 查詢用的讀取，與 `call` 分開。
 *
 * ⚠️ `call` 會把回應截成 200 字（那是給錯誤訊息用的）。
 *    2026-08-16 實測：拿它去讀 risk_config 會因為 config JSON 加 rationale
 *    遠超過 200 字而 JSON.parse 失敗，於是「已登記」被讀成「查無」。
 *    格式化錯誤用的工具不能拿來查資料。
 */
async function selectRows<T>(pathAndQuery: string): Promise<readonly T[]> {
  const res = await fetch(`${config.url}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`查詢失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as readonly T[];
}

// ── risk_config：登記內容與程式一致 ─────────────────────────────────────────
const localHash = hashRiskConfig(ACTIVE_RISK_CONFIG);
const registeredRows = await selectRows<{ config_hash: string }>(
  `risk_config?version=eq.${encodeURIComponent(ACTIVE_RISK_CONFIG.version)}&select=config_hash`,
);
const registeredHash = registeredRows[0]?.config_hash ?? null;
record(
  `風控設定 ${ACTIVE_RISK_CONFIG.version} 已登記且雜湊與程式一致`,
  registeredHash === localHash,
  registeredHash === null
    ? '⚠️ 尚未登記。先跑 npm run l3:register'
    : `登記=${registeredHash.slice(0, 16)}…　程式=${localHash.slice(0, 16)}…`,
);

// ── risk_config 三道鎖 ──────────────────────────────────────────────────────
await expectRejected(
  '事後放寬每筆風險比例（UPDATE risk_config）',
  'PATCH',
  `risk_config?version=eq.${ACTIVE_RISK_CONFIG.version}`,
  { config_hash: 'a'.repeat(64) },
  '42501',
  'permission denied',
);

await expectRejected(
  '刪除風控設定紀錄（DELETE risk_config）',
  'DELETE',
  `risk_config?version=eq.${ACTIVE_RISK_CONFIG.version}`,
  undefined,
  '42501',
  'permission denied',
);

await expectRejected(
  '偽造 registered_at（宣稱這份設定上個月就訂好了）',
  'POST',
  'risk_config',
  [
    {
      version: `probe-${PROBE_REVISION}`,
      config: { probe: true },
      config_hash: 'b'.repeat(64),
      rationale: '此列為守門驗證探針，非真實風控設定，撰寫足夠長度以通過最小長度限制。',
      registered_by: 'probe',
      registered_at: '2020-01-01T00:00:00Z',
    },
  ],
  '42501',
);

await expectRejected(
  '沒有理由的風控設定（rationale 太短）',
  'POST',
  'risk_config',
  [
    {
      version: `probe-short-${PROBE_REVISION}`,
      config: { probe: true },
      config_hash: 'c'.repeat(64),
      rationale: '沒理由',
      registered_by: 'probe',
    },
  ],
  '23514',
  'risk_config_rationale_not_blank',
);

// ── daily_picks：交易訊號的屏障守門（P7 最重要的一道） ──────────────────────
await expectAccepted('對照組：完整的交易訊號寫得進去', 'daily_picks', [signalRow()]);

await expectRejected(
  '沒有停損價的「交易訊號」',
  'POST',
  'daily_picks',
  [signalRow({ rank: 2, stop_price: null })],
  '23514',
  'daily_picks_signal_fields_check',
);

await expectRejected(
  '沒有停利價的「交易訊號」',
  'POST',
  'daily_picks',
  [signalRow({ rank: 3, take_profit_price: null })],
  '23514',
  'daily_picks_signal_fields_check',
);

await expectRejected(
  '沒有時間出場的「交易訊號」（少一道屏障就不是三屏障）',
  'POST',
  'daily_picks',
  [signalRow({ rank: 4, time_exit_days: null })],
  '23514',
  'daily_picks_signal_fields_check',
);

await expectRejected(
  '停損價高於進場價（方向寫反）',
  'POST',
  'daily_picks',
  [signalRow({ rank: 5, stop_price: 25 })],
  '23514',
  'daily_picks_barrier_order_check',
);

await expectRejected(
  '停利價低於進場價（等於「獲利就賣」的變形，CLAUDE.md 禁止）',
  'POST',
  'daily_picks',
  [signalRow({ rank: 6, take_profit_price: 19 })],
  '23514',
  'daily_picks_barrier_order_check',
);

await expectRejected(
  '張數為 0 的交易訊號',
  'POST',
  'daily_picks',
  [signalRow({ rank: 7, lots: 0, shares: 0 })],
  '23514',
  'daily_picks_position_positive_check',
);

await expectRejected(
  '沒有記錄當時資金的交易訊號（日後無法還原部位是怎麼算的）',
  'POST',
  'daily_picks',
  [signalRow({ rank: 8, equity_at_signal_twd: null })],
  '23514',
  'daily_picks_signal_fields_check',
);

await expectRejected(
  '觀察榜偷帶屏障欄位假裝成可執行訊號',
  'POST',
  'daily_picks',
  [signalRow({ rank: 9, list_kind: 'watchlist' })],
  '23514',
  'daily_picks_signal_fields_check',
);

console.log('='.repeat(64));
const failed = results.filter((r) => !r.passed);
console.log(`${results.length - failed.length}/${results.length} 通過`);
if (failed.length > 0) {
  for (const f of failed) {
    console.log(`  ✗ ${f.name}：${f.detail}`);
  }
  process.exit(1);
}
console.log('✓ L3 風控守門全部有效');
console.log('  註：探針列永久留在表中（revision ≥ 900000、code __probe），append-only 的證明。');
process.exit(0);
