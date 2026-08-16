/**
 * 計算 outcomes：`npm run l5:outcomes`（只算不寫）／`-- --write`
 *
 * ⚠️ 預設 dry-run。outcomes 是 append-only 且**僅系統可寫**，寫進去就改不掉。
 * ⚠️ 未到期（交易日不足）一律不寫。只過 3 天就寫 T+5 的數字，
 *    那個值是錯的而且事後看不出來。
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { Postgrest } from '../src/lib/l0/supabase-store';
import { SupabaseStorageBodyStore } from '../src/lib/l0/supabase-storage';
import { SnapshotLoader, SupabaseLedgerReader } from '../src/lib/l1/loader';
import { normalizeTpexQuotes, normalizeTwseQuotes } from '../src/lib/l1/normalize';
import {
  groupByCode,
  mergeEvents,
  normalizeTpexExRight,
  normalizeTwseExRight,
} from '../src/lib/l5/exright';
import type { ExRightEvent } from '../src/lib/l5/exright';
import { HORIZONS, computeOutcome } from '../src/lib/l5/outcomes';
import type { DailyBar, Horizon } from '../src/lib/l5/outcomes';

const WRITE = process.argv.includes('--write');

/** 最長觀察期 20 個交易日，多抓一些以涵蓋較早的訊號 */
const HISTORY_DAYS = 40;
/** 除權息預告表是滾動的，要跨多份快照取聯集 */
const EXRIGHT_SNAPSHOTS = 40;
export const OUTCOME_ENGINE_VERSION = 'l5-outcomes-v1';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();
const client = new Postgrest({ url: config.url, apiKey: config.serviceRoleKey });
const loader = new SnapshotLoader(
  new SupabaseLedgerReader(config.url, config.serviceRoleKey),
  new SupabaseStorageBodyStore({ url: config.url, apiKey: config.serviceRoleKey }),
);

async function select<T>(pathAndQuery: string): Promise<readonly T[]> {
  const res = await fetch(`${config.url}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`查詢失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as readonly T[];
}

interface PickRow {
  id: number;
  data_as_of: string;
  code: string;
  market: string;
  list_kind: 'watchlist' | 'trade_signal';
  price_at_push: string;
  stop_price: string | null;
  take_profit_price: string | null;
}

console.log('=== outcomes 計算 ===');
console.log(WRITE ? '模式：寫入 outcomes\n' : '模式：dry-run（只算不寫）\n');

// ── 已產生的清單（排除探針 revision ≥ 1000） ────────────────────────────────
const picks = await select<PickRow>(
  'daily_picks?revision=lt.1000&select=id,data_as_of,code,market,list_kind,price_at_push,' +
    'stop_price,take_profit_price&order=data_as_of.asc,rank.asc',
);
console.log(`daily_picks 共 ${picks.length} 列（已排除探針）`);
if (picks.length === 0) {
  console.log('沒有任何清單，無事可做。');
  process.exit(0);
}

// ── 交易日序列與逐日價格 ────────────────────────────────────────────────────
const [twseHistory, tpexHistory] = await Promise.all([
  loader.recentDays('twse_stock_day_all', HISTORY_DAYS),
  loader.recentDays('tpex_mainboard_daily_close_quotes', HISTORY_DAYS),
]);
const tpexByDate = new Map(tpexHistory.map((s) => [s.ref.dataAsOf!, s]));

/** 交易日以上市行情為準 */
const tradingDates = twseHistory.map((s) => s.ref.dataAsOf!);
const barsByCode = new Map<string, Map<string, DailyBar>>();

for (const snapshot of twseHistory) {
  const date = snapshot.ref.dataAsOf!;
  const tpex = tpexByDate.get(date);
  const quotes = [
    ...normalizeTwseQuotes(snapshot.payload, date).rows,
    ...(tpex === undefined ? [] : normalizeTpexQuotes(tpex.payload, date).rows),
  ];
  for (const q of quotes) {
    let series = barsByCode.get(q.code);
    if (series === undefined) {
      series = new Map<string, DailyBar>();
      barsByCode.set(q.code, series);
    }
    series.set(date, { date, high: q.high, low: q.low, close: q.close });
  }
}
console.log(`交易日序列 ${tradingDates.length} 天：${tradingDates.join(', ') || '無'}`);

// ── 除權息事件（跨快照取聯集） ──────────────────────────────────────────────
const [twseEx, tpexEx] = await Promise.all([
  loader.recentDays('twse_exright_forecast', EXRIGHT_SNAPSHOTS),
  loader.recentDays('tpex_exright_forecast', EXRIGHT_SNAPSHOTS),
]);
const exEvents = mergeEvents([
  ...twseEx.map((s) => normalizeTwseExRight(s.payload)),
  ...tpexEx.map((s) => normalizeTpexExRight(s.payload)),
]);
const exByCode = groupByCode(exEvents);
console.log(
  `除權息事件 ${exEvents.length} 筆（來自 ${twseEx.length + tpexEx.length} 份快照的聯集）`,
);

// ── 逐筆計算 ────────────────────────────────────────────────────────────────
interface OutcomeRow {
  pick_id: number;
  data_as_of: string;
  code: string;
  market: string;
  list_kind: string;
  horizon: number;
  exit_date: string;
  entry_price: number;
  exit_price: number;
  raw_return_pct: number;
  adjusted_return_pct: number;
  share_factor: number;
  cash_dividend_per_share: number;
  ex_right_count: number;
  has_rights_issue: boolean;
  barrier_touched: string | null;
  barrier_touch_date: string | null;
  trading_days_used: number;
  engine_version: string;
  computed_at: string;
}

const computedAt = new Date().toISOString();
const rows: OutcomeRow[] = [];
const statusCounts: Record<string, number> = {};

for (const pick of picks) {
  const events: readonly ExRightEvent[] = exByCode.get(pick.code) ?? [];
  const bars = barsByCode.get(pick.code) ?? new Map<string, DailyBar>();
  const barriers =
    pick.list_kind === 'trade_signal' && pick.stop_price !== null && pick.take_profit_price !== null
      ? { stopPrice: Number(pick.stop_price), takeProfitPrice: Number(pick.take_profit_price) }
      : null;

  for (const horizon of HORIZONS) {
    const result = computeOutcome(
      {
        signalDate: pick.data_as_of,
        entryPrice: Number(pick.price_at_push),
        tradingDates,
        barsByDate: bars,
        exRightEvents: events,
        barriers,
      },
      horizon as Horizon,
    );
    statusCounts[result.status] = (statusCounts[result.status] ?? 0) + 1;
    if (result.status !== 'computed') {
      continue;
    }
    rows.push({
      pick_id: pick.id,
      data_as_of: pick.data_as_of,
      code: pick.code,
      market: pick.market,
      list_kind: pick.list_kind,
      horizon,
      exit_date: result.exitDate!,
      entry_price: Number(pick.price_at_push),
      exit_price: result.exitPrice!,
      raw_return_pct: result.rawReturnPct!,
      adjusted_return_pct: result.adjustedReturnPct!,
      share_factor: result.shareFactor,
      cash_dividend_per_share: result.cashDividendPerShare,
      ex_right_count: result.exRightCount,
      has_rights_issue: result.hasRightsIssue,
      barrier_touched: result.barrierTouched,
      barrier_touch_date: result.barrierTouchDate,
      trading_days_used: result.tradingDaysUsed,
      engine_version: OUTCOME_ENGINE_VERSION,
      computed_at: computedAt,
    });
  }
}

console.log('\n--- 計算狀態 ---');
for (const [status, count] of Object.entries(statusCounts)) {
  const label =
    status === 'not_mature'
      ? '尚未到期（交易日不足，這是正常的）'
      : status === 'no_price_at_exit'
        ? '出場日無價格（停牌等），不硬算'
        : '已算出';
  console.log(`  ${status.padEnd(18)} ${String(count).padStart(5)}　${label}`);
}

if (rows.length === 0) {
  console.log('\n沒有任何已到期的觀察值。');
  console.log(
    `最長觀察期需要 20 個交易日，系統目前累積 ${tradingDates.length} 個。` +
      '這是資料累積不足，不是計算失敗。',
  );
  process.exit(0);
}

// ── 已排除的重複（append-only，同一筆只能算一次） ───────────────────────────
const existing = await select<{ pick_id: number; horizon: number }>(
  'outcomes?select=pick_id,horizon',
);
const existingKeys = new Set(existing.map((e) => `${e.pick_id}|${e.horizon}`));
const fresh = rows.filter((r) => !existingKeys.has(`${r.pick_id}|${r.horizon}`));
console.log(`\n已算出 ${rows.length} 列，其中 ${rows.length - fresh.length} 列先前已寫入`);

console.log('\n--- 摘要（含息報酬）---');
for (const horizon of HORIZONS) {
  const subset = rows.filter((r) => r.horizon === horizon);
  if (subset.length === 0) continue;
  const returns = subset.map((r) => r.adjusted_return_pct).sort((a, b) => a - b);
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const median = returns[Math.floor(returns.length / 2)]!;
  const withEx = subset.filter((r) => r.ex_right_count > 0).length;
  const rawMean =
    subset.map((r) => r.raw_return_pct).reduce((s, v) => s + v, 0) / subset.length;
  console.log(
    `T+${horizon}　${subset.length} 筆｜平均 ${mean.toFixed(2)}%｜中位 ${median.toFixed(2)}%｜` +
      `未還原平均 ${rawMean.toFixed(2)}%（差額 ${(mean - rawMean).toFixed(2)}pp 來自 ${withEx} 筆除權息）`,
  );
}

if (!WRITE) {
  console.log('\n（dry-run，未寫入。確認無誤後加 --write）');
  process.exit(0);
}

if (fresh.length === 0) {
  console.log('\n沒有新的觀察值需要寫入。');
  process.exit(0);
}

await client.insert('outcomes', fresh);
console.log(`\n✓ 已寫入 outcomes：${fresh.length} 列`);
console.log('  append-only 且僅系統可寫，此後不可修改或刪除。');
process.exit(0);
