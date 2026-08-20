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
import { rocDateToIso } from '../l0/roc-date';

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

// ── P11.15：官方加權股價報酬指數（含息） ─────────────────────────────────────

/**
 * 第二個市場基準的代號。
 *
 * 【為什麼要第二個基準，明明 CLAUDE.md 只寫 0050】
 * 0050 是 ETF：有折溢價、有管理費、有追蹤誤差，它衡量的是「你真的買得到的東西」。
 * 官方的加權股價報酬指數衡量的是「市場本身」，沒有這些雜訊。
 * 兩個一起看才分得出來「輸給市場」和「輸給那檔 ETF」。
 *
 * ⚠️ **G3 的判準不因此放寬。** 多一個對照組只會讓標準更難達成，不會更容易。
 *    CLAUDE.md 寫的 0050 仍是主判準，這個是補充資訊。
 */
export const TAIEX_TOTAL_RETURN_CODE = 'TAIEX_TR';

export interface OfficialIndexPoint {
  readonly date: string;
  /** 官方公布的指數值原值 */
  readonly value: number;
}

/**
 * 解析 TWSE MFI94U（發行量加權股價報酬指數）。
 *
 * 實測（2026-08-20）：13 列滾動視窗，欄位 Date（民國壓縮）／TAIEXTotalReturnIndex。
 *
 * ⚠️ **這個指數本身就已含息**，不需要再做除權息還原 ——
 *    對它套用 0050 那套配息加回的邏輯會把股利算兩次。
 *    這正是它比 0050 乾淨的地方，也是最容易搞錯的地方。
 */
export function normalizeTaiexTotalReturn(payload: unknown): readonly OfficialIndexPoint[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const points: OfficialIndexPoint[] = [];
  for (const raw of payload) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const r = raw as Record<string, unknown>;
    const date = rocDateToIso(typeof r['Date'] === 'string' ? r['Date'] : '');
    const value = Number(
      typeof r['TAIEXTotalReturnIndex'] === 'string'
        ? r['TAIEXTotalReturnIndex'].replace(/,/gu, '')
        : r['TAIEXTotalReturnIndex'],
    );
    if (date === null || !Number.isFinite(value) || value <= 0) {
      continue;
    }
    points.push({ date, value });
  }
  return points;
}

/**
 * 把多份滾動視窗快照併成一條唯一日期的序列，並正規化成起始日 = 100。
 *
 * 【為什麼可以任意選基準日】
 * G3 比的是兩個日期之間的**比值**，比值不受基準日影響。
 * 取序列第一天為 100 只是為了和 0050 的表示方式一致，方便並排看。
 *
 * 【同一天出現在多份快照時取哪一份】
 * 值應該完全相同（官方歷史值不會變）。若不同，代表官方修正過數字，
 * 此時取**最早抓到**的那一份 —— 那是我們當時真正看到的值，
 * 用後來修正的數字回頭評估當時的決策就是前視偏誤。
 */
export function buildOfficialIndex(
  snapshots: readonly (readonly OfficialIndexPoint[])[],
): readonly IndexPoint[] {
  const byDate = new Map<string, number>();
  for (const points of snapshots) {
    for (const p of points) {
      if (!byDate.has(p.date)) {
        byDate.set(p.date, p.value);
      }
    }
  }
  const sorted = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const base = sorted[0]?.[1];
  if (base === undefined || base <= 0) {
    return [];
  }
  return sorted.map(([date, value]) => ({
    date,
    close: value,
    cashDividend: 0,
    stockDividendRatio: 0,
    totalReturnIndex: (value / base) * 100,
  }));
}
