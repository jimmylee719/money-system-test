/**
 * 0050 基準。純函式。
 *
 * 【CLAUDE.md：風險調整後淨報酬須勝過 0050 買入持有，否則系統無存在價值】
 * 這是 G3，也是整個專案唯一真正重要的問題。
 *
 * 【必須用含息報酬跟含息報酬比】
 * 0050 每年配息，若拿「0050 不含息」跟「個股含息」比，是在放水；
 * 反過來則是自我懲罰。兩邊都用還原後的總報酬，才是公平的比較。
 * 幸好除權息預告表也涵蓋 ETF（實測 36 檔），所以 0050 的配息拿得到。
 *
 * 【逐筆對齊比較，不是比累積曲線】
 * 對每一筆訊號，算 0050 在**完全相同的進出場日**的報酬，兩者相減。
 * 這樣才控制得住大盤方向——如果大盤漲 10% 而我們的標的漲 8%，
 * 那是輸了，不是賺了。比累積曲線會被進出場時點差異汙染。
 */

import type { ExRightEvent } from '../l5/exright';
import { adjustmentFor, totalReturn } from '../l5/exright';

/** CLAUDE.md 指定的基準：元大台灣50 */
export const BENCHMARK_CODE = '0050';

export interface BenchmarkBar {
  readonly date: string;
  readonly close: number;
}

/**
 * 基準在 `(fromDate, toDate]` 的含息總報酬（小數，非百分比）。
 *
 * 與個股用**完全相同**的還原邏輯與區間規則（左開右閉），
 * 否則兩邊的定義不一致，相減出來的「超額報酬」沒有意義。
 *
 * @returns null 代表任一端沒有價格，無法比較——不猜、不內插
 */
export function benchmarkReturn(
  barsByDate: ReadonlyMap<string, BenchmarkBar>,
  exRightEvents: readonly ExRightEvent[],
  fromDate: string,
  toDate: string,
): number | null {
  const from = barsByDate.get(fromDate);
  const to = barsByDate.get(toDate);
  if (from === undefined || to === undefined || from.close <= 0 || to.close <= 0) {
    return null;
  }
  return totalReturn(from.close, to.close, adjustmentFor(exRightEvents, fromDate, toDate));
}

/**
 * 總報酬指數（起點 100）。供 Dashboard 畫圖與計算最大回撤。
 *
 * 每一天的指數 = 前一天指數 ×（今日含息報酬 + 1）。
 * 除權息當日的價格跌幅會被股利補回，因此指數不會出現假跌。
 */
export interface IndexPoint {
  readonly date: string;
  readonly close: number;
  readonly totalReturnIndex: number;
  /** 當日的現金股利（元／股），0 表示無 */
  readonly cashDividend: number;
  /** 當日的配股率，0 表示無 */
  readonly stockDividendRatio: number;
}

export function buildTotalReturnIndex(
  bars: readonly BenchmarkBar[],
  exRightEvents: readonly ExRightEvent[],
  base = 100,
): readonly IndexPoint[] {
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  const eventByDate = new Map(exRightEvents.map((e) => [e.exDate, e]));
  const points: IndexPoint[] = [];

  let index = base;
  let previous: BenchmarkBar | null = null;

  for (const bar of sorted) {
    const event = eventByDate.get(bar.date);
    if (previous !== null && previous.close > 0) {
      const adjustment = adjustmentFor(exRightEvents, previous.date, bar.date);
      index *= 1 + totalReturn(previous.close, bar.close, adjustment);
    }
    points.push({
      date: bar.date,
      close: bar.close,
      totalReturnIndex: index,
      cashDividend: event?.cashDividend ?? 0,
      stockDividendRatio: event?.stockDividendRatio ?? 0,
    });
    previous = bar;
  }
  return points;
}

/**
 * 最大回撤（MDD，正數表示回撤幅度）。
 *
 * CLAUDE.md 的主指標之一，也是「風險調整」的風險那一半。
 * 用總報酬指數算，不是用價格——否則除權息會被算成回撤。
 */
export function maxDrawdown(points: readonly IndexPoint[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const point of points) {
    peak = Math.max(peak, point.totalReturnIndex);
    if (peak > 0) {
      mdd = Math.max(mdd, (peak - point.totalReturnIndex) / peak);
    }
  }
  return mdd;
}
