/**
 * G3 對照報告：`npm run l6:g3`（只算不寫）／`-- --write` 寫入 benchmark_daily
 *
 * CLAUDE.md：風險調整後淨報酬須勝過 0050 買入持有，否則系統無存在價值。
 *
 * 【逐筆對齊比較，不是比累積曲線】
 * 對每一筆已到期的結果，算 0050 在**完全相同的進出場日**的含息報酬，兩者相減。
 * 這樣才控制得住大盤方向——大盤漲 10% 而我們漲 8%，那是輸了不是賺了。
 *
 * 【樣本 < 30 筆不下結論】
 * CLAUDE.md 的硬規定。數字照印，但明確標示不得據以判斷。
 *
 * ⚠️ 本程式不印出任何金鑰內容。
 */

import { loadEnvFileIfPresent, loadSupabaseConfig } from '../src/lib/config/env';
import { Postgrest } from '../src/lib/l0/supabase-store';
import { SupabaseStorageBodyStore } from '../src/lib/l0/supabase-storage';
import { SnapshotLoader, SupabaseLedgerReader } from '../src/lib/l1/loader';
import { normalizeTwseQuotes } from '../src/lib/l1/normalize';
import { groupByCode, mergeEvents, normalizeTwseExRight } from '../src/lib/l5/exright';
import { HORIZONS } from '../src/lib/l5/outcomes';
import {
  BENCHMARK_CODE,
  benchmarkReturn,
  buildTotalReturnIndex,
  maxDrawdown,
} from '../src/lib/l6/benchmark';
import type { BenchmarkBar } from '../src/lib/l6/benchmark';
import { compareSplit } from '../src/lib/l6/comparison';
import type { MatchedObservation } from '../src/lib/l6/comparison';

const WRITE = process.argv.includes('--write');
const HISTORY_DAYS = 120;
export const BENCHMARK_ENGINE_VERSION = 'l6-benchmark-v1';

loadEnvFileIfPresent();
const config = loadSupabaseConfig();
const client = new Postgrest({ url: config.url, apiKey: config.serviceRoleKey });
const loader = new SnapshotLoader(
  new SupabaseLedgerReader(config.url, config.serviceRoleKey),
  new SupabaseStorageBodyStore({ url: config.url, apiKey: config.serviceRoleKey }),
);

async function select<T>(query: string): Promise<readonly T[]> {
  const res = await fetch(`${config.url}/rest/v1/${query}`, {
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 404) {
    console.log(`⚠️ 資料表尚未建立：${query.split('?')[0]}`);
    return [];
  }
  if (!res.ok) {
    throw new Error(`查詢失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as readonly T[];
}

console.log('=== G3：與 0050 買入持有的對照 ===');
console.log(WRITE ? '模式：寫入 benchmark_daily\n' : '模式：dry-run（只算不寫）\n');

// ── 0050 的每日價格與配息 ───────────────────────────────────────────────────
const quoteSnapshots = await loader.recentDays('twse_stock_day_all', HISTORY_DAYS);
const bars: BenchmarkBar[] = [];
for (const snapshot of quoteSnapshots) {
  const date = snapshot.ref.dataAsOf!;
  const row = normalizeTwseQuotes(snapshot.payload, date).rows.find(
    (r) => r.code === BENCHMARK_CODE,
  );
  if (row?.close !== null && row?.close !== undefined && row.close > 0) {
    bars.push({ date, close: row.close });
  }
}

const exSnapshots = await loader.recentDays('twse_exright_forecast', HISTORY_DAYS);
const allEvents = mergeEvents(exSnapshots.map((s) => normalizeTwseExRight(s.payload)));
const benchmarkEvents = groupByCode(allEvents).get(BENCHMARK_CODE) ?? [];

console.log(`0050 價格：${bars.length} 個交易日｜配息事件：${benchmarkEvents.length} 筆`);
if (bars.length === 0) {
  console.log('✗ 沒有 0050 的價格資料，無法計算基準。');
  process.exit(1);
}

const index = buildTotalReturnIndex(bars, benchmarkEvents);
const first = index[0]!;
const last = index[index.length - 1]!;
const periodReturn = (last.totalReturnIndex / first.totalReturnIndex - 1) * 100;

console.log(
  `\n0050 期間表現（${first.date} ~ ${last.date}）：` +
    `含息總報酬 ${periodReturn.toFixed(2)}%｜最大回撤 ${(maxDrawdown(index) * 100).toFixed(2)}%`,
);
if (index.length < 2) {
  console.log('（只有一天，尚無法計算報酬與回撤）');
}

const barsByDate = new Map(bars.map((b) => [b.date, b]));

// ── 已到期的結果 vs 基準 ────────────────────────────────────────────────────
interface OutcomeRow {
  code: string;
  data_as_of: string;
  exit_date: string;
  horizon: number;
  list_kind: string;
  adjusted_return_pct: string;
}
const outcomes = await select<OutcomeRow>(
  'outcomes?pick_id=lt.900000000&select=code,data_as_of,exit_date,horizon,list_kind,adjusted_return_pct',
);

console.log(`\n已到期的結果：${outcomes.length} 筆`);

if (outcomes.length === 0) {
  console.log('\n尚無已到期的結果，無法做 G3 對照。');
  console.log('第一批 T+5 結果需累積 5 個交易日，T+20 需 20 個。');
} else {
  for (const horizon of HORIZONS) {
    const subset = outcomes.filter((o) => o.horizon === horizon);
    if (subset.length === 0) continue;

    const toObservation = (o: OutcomeRow): MatchedObservation => ({
      code: o.code,
      dataAsOf: o.data_as_of,
      exitDate: o.exit_date,
      horizon: o.horizon,
      assetReturnPct: Number(o.adjusted_return_pct),
      benchmarkReturnPct: (() => {
        const r = benchmarkReturn(barsByDate, benchmarkEvents, o.data_as_of, o.exit_date);
        return r === null ? null : r * 100;
      })(),
    });

    const split = compareSplit(
      subset.filter((o) => o.list_kind === 'watchlist').map(toObservation),
      subset.filter((o) => o.list_kind === 'trade_signal').map(toObservation),
      horizon,
    );

    console.log(`\n${'─'.repeat(64)}`);
    console.log(`T+${horizon}`);
    for (const [label, result] of [
      ['觀察榜（純排序，不受 L2／L3 影響）', split.watchlist],
      ['交易訊號（通過 L2＋L3）', split.tradeSignal],
    ] as const) {
      console.log(`\n  ${label}`);
      console.log(
        `    樣本 ${result.sampleSize} 筆` +
          (result.unmatched > 0 ? `（另有 ${result.unmatched} 筆因基準缺價格無法比較）` : ''),
      );
      if (result.sampleSize > 0) {
        console.log(
          `    個股平均 ${result.meanAssetPct.toFixed(2)}%　` +
            `0050 同期 ${result.meanBenchmarkPct.toFixed(2)}%　` +
            `超額 ${result.meanExcessPct >= 0 ? '+' : ''}${result.meanExcessPct.toFixed(2)}pp`,
        );
        console.log(
          `    超額標準差 ${result.excessStdevPct.toFixed(2)}pp　` +
            `平均/標準差 ${result.excessMeanOverStdev === null ? '－' : result.excessMeanOverStdev.toFixed(3)}`,
        );
      }
      console.log(`    ${result.verdict}`);
    }
    console.log(`\n  解讀：${split.interpretation}`);
  }
}

// ── 寫入 benchmark_daily ────────────────────────────────────────────────────
if (!WRITE) {
  console.log('\n（dry-run，未寫入。確認無誤後加 --write）');
  process.exit(0);
}

const existing = await select<{ date: string }>(
  `benchmark_daily?code=eq.${BENCHMARK_CODE}&select=date`,
);
const existingDates = new Set(existing.map((e) => e.date));
const computedAt = new Date().toISOString();
const fresh = index
  .filter((p) => !existingDates.has(p.date))
  .map((p) => ({
    code: BENCHMARK_CODE,
    date: p.date,
    close: p.close,
    cash_dividend: p.cashDividend,
    stock_dividend_ratio: p.stockDividendRatio,
    total_return_index: p.totalReturnIndex,
    engine_version: BENCHMARK_ENGINE_VERSION,
    computed_at: computedAt,
  }));

if (fresh.length === 0) {
  console.log('\nbenchmark_daily 已是最新，無需寫入。');
  process.exit(0);
}

await client.insert('benchmark_daily', fresh);
console.log(`\n✓ 已寫入 benchmark_daily：${fresh.length} 列`);
console.log('  append-only，此後不可修改或刪除。');
process.exit(0);
