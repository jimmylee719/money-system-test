/**
 * outcomes：訊號發出後的實際結果。純函式。
 *
 * 【這張表是整個系統唯一的成績單】
 * G1（≥100 筆訊號）、G2（期望值 >0、獲利因子 >1.3）、G3（勝過 0050）
 * 全部建立在這裡算出來的數字上。算錯不會有人抗議，只會讓錯誤的結論看起來很可信。
 *
 * 【T+N 是交易日，不是日曆日】
 * 用實際存在的交易日快照序列決定，不用日曆推算——
 * 推算會撞到週末、國定假日與颱風假。
 *
 * 【未到期就不算，不算一半】
 * 只過了 3 天就寫 T+5 的結果，那個數字是錯的而且看不出來。
 * 天數不足一律回報 `not_mature`，不寫入。
 *
 * 【屏障要跟著除權息調整，否則會被誤觸】
 * 除權息當天股價機械式下跌，若不同步調整停損價，
 * 會把「配息」誤判成「跌破停損」。調整方式與交易所的參考價公式一致：
 *   調整後屏障 =（原屏障 − 現金股利）÷（1 + 配股率）
 */

import type { ExRightEvent, HoldingAdjustment } from './exright';
import { adjustmentFor, rawReturn, totalReturn } from './exright';

/** CLAUDE.md 指定的三個觀察期（交易日） */
export const HORIZONS = [5, 10, 20] as const;
export type Horizon = (typeof HORIZONS)[number];

/** 一個交易日的價格。停牌等無資料的日子不會出現在序列中。 */
export interface DailyBar {
  readonly date: string;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number | null;
}

export type OutcomeStatus =
  /** 觀察期尚未走完，不計算 */
  | 'not_mature'
  /** 出場日該檔沒有價格（停牌等），無法計算 */
  | 'no_price_at_exit'
  /** 正常算出 */
  | 'computed';

export type BarrierTouch = 'stop' | 'target' | 'time' | 'none';

export interface OutcomeInput {
  /** 訊號日（＝排序所用資料的交易日） */
  readonly signalDate: string;
  readonly entryPrice: number;
  /** 全市場交易日序列，升冪，須包含 signalDate */
  readonly tradingDates: readonly string[];
  /** 該檔的逐日價格，date → bar。缺的日子代表當天無資料。 */
  readonly barsByDate: ReadonlyMap<string, DailyBar>;
  /** 該檔的除權息事件（可含期間外的，函式自行篩選） */
  readonly exRightEvents: readonly ExRightEvent[];
  /** 三道屏障。觀察榜沒有屏障，傳 null。 */
  readonly barriers: { readonly stopPrice: number; readonly takeProfitPrice: number } | null;
}

export interface OutcomeResult {
  readonly horizon: Horizon;
  readonly status: OutcomeStatus;
  readonly exitDate: string | null;
  readonly exitPrice: number | null;
  /** 未還原除權息的帳面報酬 */
  readonly rawReturnPct: number | null;
  /** 還原除權息後的含息總報酬。這才是評估用的數字。 */
  readonly adjustedReturnPct: number | null;
  readonly shareFactor: number;
  readonly cashDividendPerShare: number;
  readonly hasRightsIssue: boolean;
  /** 期間內是否有除權息（用來稽核 raw 與 adjusted 的差額） */
  readonly exRightCount: number;
  /** 屏障觸及。觀察榜為 null。 */
  readonly barrierTouched: BarrierTouch | null;
  readonly barrierTouchDate: string | null;
  /** 實際用到的交易日數，供稽核 */
  readonly tradingDaysUsed: number;
}

/**
 * 依除權息調整屏障價。
 *
 * 與交易所參考價同一個公式：除權息後的價格尺度整體縮小，
 * 屏障必須跟著縮，否則等於在除權息當天無故收緊停損。
 */
export function adjustBarrier(
  barrier: number,
  events: readonly ExRightEvent[],
  afterDate: string,
  throughDate: string,
): number {
  let adjusted = barrier;
  const inWindow = events
    .filter((e) => e.exDate > afterDate && e.exDate <= throughDate)
    .sort((a, b) => a.exDate.localeCompare(b.exDate));
  for (const event of inWindow) {
    adjusted = (adjusted - event.cashDividend) / (1 + event.stockDividendRatio);
  }
  return adjusted;
}

/**
 * 掃描屏障觸及。
 *
 * 【同一天同時觸及停損與停利時，一律判停損】
 * 只有日 K 的高低價，無法得知盤中誰先到。取最壞情況是唯一誠實的做法——
 * 反過來假設先觸停利，會系統性高估績效，而那正是要避免的事。
 */
export function scanBarriers(
  bars: readonly DailyBar[],
  stopPrice: number,
  takeProfitPrice: number,
  events: readonly ExRightEvent[],
  signalDate: string,
): { touched: BarrierTouch; date: string | null } {
  for (const bar of bars) {
    // 屏障調整到「這一天」的價格尺度
    const stop = adjustBarrier(stopPrice, events, signalDate, bar.date);
    const target = adjustBarrier(takeProfitPrice, events, signalDate, bar.date);

    const hitStop = bar.low !== null && bar.low <= stop;
    const hitTarget = bar.high !== null && bar.high >= target;

    if (hitStop) {
      return { touched: 'stop', date: bar.date }; // 同日皆觸及也判停損
    }
    if (hitTarget) {
      return { touched: 'target', date: bar.date };
    }
  }
  return { touched: 'none', date: null };
}

/** 取訊號日之後的第 1..N 個交易日 */
function forwardDates(
  tradingDates: readonly string[],
  signalDate: string,
  horizon: number,
): readonly string[] | null {
  const index = tradingDates.indexOf(signalDate);
  if (index < 0) {
    return null;
  }
  const window = tradingDates.slice(index + 1, index + 1 + horizon);
  return window.length < horizon ? null : window;
}

export function computeOutcome(input: OutcomeInput, horizon: Horizon): OutcomeResult {
  const empty = {
    horizon,
    exitDate: null,
    exitPrice: null,
    rawReturnPct: null,
    adjustedReturnPct: null,
    shareFactor: 1,
    cashDividendPerShare: 0,
    hasRightsIssue: false,
    exRightCount: 0,
    barrierTouched: null,
    barrierTouchDate: null,
    tradingDaysUsed: 0,
  } as const;

  const window = forwardDates(input.tradingDates, input.signalDate, horizon);
  if (window === null) {
    return { ...empty, status: 'not_mature' };
  }

  const exitDate = window[window.length - 1]!;
  const exitBar = input.barsByDate.get(exitDate);
  const adjustment: HoldingAdjustment = adjustmentFor(
    input.exRightEvents,
    input.signalDate,
    exitDate,
  );

  const barrierScan =
    input.barriers === null
      ? { touched: null, date: null }
      : scanBarriers(
          window.map((d) => input.barsByDate.get(d)).filter((b): b is DailyBar => b !== undefined),
          input.barriers.stopPrice,
          input.barriers.takeProfitPrice,
          input.exRightEvents,
          input.signalDate,
        );

  // 沒觸及屏障而走完觀察期 → 時間出場
  const touched: BarrierTouch | null =
    input.barriers === null ? null : barrierScan.touched === 'none' ? 'time' : barrierScan.touched;

  if (exitBar === undefined || exitBar.close === null || exitBar.close <= 0) {
    return {
      ...empty,
      status: 'no_price_at_exit',
      exitDate,
      shareFactor: adjustment.shareFactor,
      cashDividendPerShare: adjustment.cashPerOriginalShare,
      hasRightsIssue: adjustment.hasRightsIssue,
      exRightCount: adjustment.events.length,
      barrierTouched: touched,
      barrierTouchDate: barrierScan.date,
      tradingDaysUsed: window.length,
    };
  }

  return {
    horizon,
    status: 'computed',
    exitDate,
    exitPrice: exitBar.close,
    rawReturnPct: rawReturn(input.entryPrice, exitBar.close) * 100,
    adjustedReturnPct: totalReturn(input.entryPrice, exitBar.close, adjustment) * 100,
    shareFactor: adjustment.shareFactor,
    cashDividendPerShare: adjustment.cashPerOriginalShare,
    hasRightsIssue: adjustment.hasRightsIssue,
    exRightCount: adjustment.events.length,
    barrierTouched: touched,
    barrierTouchDate: barrierScan.date,
    tradingDaysUsed: window.length,
  };
}

/** 一次算完三個觀察期 */
export function computeAllHorizons(input: OutcomeInput): readonly OutcomeResult[] {
  return HORIZONS.map((h) => computeOutcome(input, h));
}
