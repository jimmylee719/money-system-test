/**
 * L3 風控引擎。**硬上限，無例外**（CLAUDE.md）。
 *
 * 【和 L2 一樣只能減少行動，而且同樣由結構保證】
 * 核准的標的必定是輸入的子集合，且「核准數 + 被拒絕的相異代號數 = 輸入數」，
 * 不符即拋錯。差別在於 L3 的輸出帶有部位大小與屏障，是新物件，
 * 所以比對的是代號而不是物件本身。
 *
 * 【全域限制先於個股判斷】
 * 熔斷與換手預算是**整體**狀態：一旦觸發，當日一律 0 檔，
 * 不會出現「雖然熔斷了但這檔特別好所以放行」。那正是硬上限的意思。
 *
 * 【曝險上限依序累加，順序即排名順序】
 * 名次高的先取得額度。這是刻意的：額度有限時應該給排序認為最好的，
 * 而不是給代號比較小的。
 */

import type { RankedStock } from '../l1/factors/engine';
import { computeBarriers, BarrierError } from './barriers';
import type { TripleBarrier } from './barriers';
import type { RiskConfig } from './config';
import { sizePosition } from './sizing';
import type { SizedPosition } from './sizing';
import type { DailyVolatility } from './volatility';

export type RiskRejectReason =
  /** 熔斷：淨值回撤超過容忍值 */
  | 'circuit_breaker'
  /** 當月進場筆數已達硬上限 */
  | 'monthly_turnover_cap'
  /** 同時持有部位數已達上限 */
  | 'concurrent_position_cap'
  /** 總曝險已達上限 */
  | 'total_exposure_cap'
  /** 波動率估不出來（歷史不足）→ 無法設定屏障 */
  | 'volatility_unavailable'
  /** 波動過大，停損價會是負數 */
  | 'barrier_infeasible'
  /** 資金不足以買進 1 張 */
  | 'below_one_lot'
  /** 單一部位金額超過上限 */
  | 'exceeds_single_position_cap'
  /** 停利價未達損益兩平，數學上不可能獲利 */
  | 'target_below_breakeven';

export interface RiskRejection {
  readonly code: string;
  readonly reason: RiskRejectReason;
  readonly detail: string;
}

export interface ApprovedSignal {
  readonly stock: RankedStock;
  readonly barrier: TripleBarrier;
  readonly position: SizedPosition;
  readonly sigmaDaily: number;
  readonly volObservations: number;
}

export interface RiskContext {
  /** 訊號日 'YYYY-MM-DD' */
  readonly signalDate: string;
  /** code → 該檔的波動率估計 */
  readonly volatilityByCode: ReadonlyMap<string, DailyVolatility>;
  /** 當月已進場筆數（自 daily_picks 的 trade_signal 統計） */
  readonly entriesThisMonth: number;
  /** 目前持有的部位數 */
  readonly openPositions: number;
  /** 目前已用曝險佔總資金比例（%） */
  readonly currentExposurePct: number;
  /**
   * 目前淨值回撤（%，正數表示回撤）。
   * v1 不下單、尚無實際淨值，故由呼叫端傳 0 並在報表上註明「尚未啟用」。
   */
  readonly drawdownPct: number;
}

export interface RiskResult {
  readonly approved: readonly ApprovedSignal[];
  readonly rejected: readonly RiskRejection[];
  readonly countsByReason: Readonly<Record<string, number>>;
  /** 全域限制觸發（熔斷或換手預算），當日一律 0 檔 */
  readonly haltedGlobally: boolean;
  readonly haltReason: string | null;
}

export class RiskLayerViolationError extends Error {
  constructor(detail: string) {
    super(
      `L3 風控層違反「只能減少行動」：${detail}。` +
        'L3 是硬上限，核准清單必須是輸入的子集合。',
    );
    this.name = 'RiskLayerViolationError';
  }
}

function haltAll(
  candidates: readonly RankedStock[],
  reason: RiskRejectReason,
  detail: string,
): RiskResult {
  return {
    approved: [],
    rejected: candidates.map((c) => ({ code: c.code, reason, detail })),
    countsByReason: { [reason]: candidates.length },
    haltedGlobally: true,
    haltReason: detail,
  };
}

/**
 * 套用全部風控限制。
 *
 * @param candidates 已通過 L2 的候選，**依排名順序**（額度有限時先給名次高的）
 */
export function applyRiskLimits(
  candidates: readonly RankedStock[],
  ctx: RiskContext,
  config: RiskConfig,
): RiskResult {
  // ── 全域限制：一旦觸發，當日一律 0 檔，沒有例外 ──────────────────────────
  if (ctx.drawdownPct >= config.circuitBreakerDrawdownPct) {
    return haltAll(
      candidates,
      'circuit_breaker',
      `淨值回撤 ${ctx.drawdownPct.toFixed(1)}% 已達熔斷門檻 ${config.circuitBreakerDrawdownPct}%，停機檢討`,
    );
  }
  if (ctx.entriesThisMonth >= config.monthlyEntryCap) {
    return haltAll(
      candidates,
      'monthly_turnover_cap',
      `當月已進場 ${ctx.entriesThisMonth} 筆，達硬上限 ${config.monthlyEntryCap} 筆`,
    );
  }

  const approved: ApprovedSignal[] = [];
  const rejected: RiskRejection[] = [];
  const counts: Record<string, number> = {};

  let openPositions = ctx.openPositions;
  let exposurePct = ctx.currentExposurePct;
  let entriesThisMonth = ctx.entriesThisMonth;

  const reject = (code: string, reason: RiskRejectReason, detail: string): void => {
    rejected.push({ code, reason, detail });
    counts[reason] = (counts[reason] ?? 0) + 1;
  };

  for (const stock of candidates) {
    // 名額類限制會隨著核准而消耗，故在迴圈內逐一重新檢查
    if (entriesThisMonth >= config.monthlyEntryCap) {
      reject(
        stock.code,
        'monthly_turnover_cap',
        `當月進場筆數已達上限 ${config.monthlyEntryCap} 筆`,
      );
      continue;
    }
    if (openPositions >= config.maxConcurrentPositions) {
      reject(
        stock.code,
        'concurrent_position_cap',
        `同時持有部位已達上限 ${config.maxConcurrentPositions} 檔`,
      );
      continue;
    }

    const vol = ctx.volatilityByCode.get(stock.code);
    if (vol === undefined || vol.sigmaDaily === null) {
      reject(
        stock.code,
        'volatility_unavailable',
        vol?.reason ?? '沒有這一檔的價格歷史，無法估波動率',
      );
      continue;
    }

    let barrier: TripleBarrier;
    try {
      barrier = computeBarriers({
        entryPrice: stock.close,
        sigmaDaily: vol.sigmaDaily,
        holdingDays: config.holdingDays,
        stopSigmaMultiple: config.stopSigmaMultiple,
        takeProfitR: config.takeProfitR,
      });
    } catch (error) {
      if (error instanceof BarrierError) {
        reject(stock.code, 'barrier_infeasible', error.message);
        continue;
      }
      throw error;
    }

    const sized = sizePosition({
      barrier,
      equityTwd: config.equityTwd,
      riskPerTradePct: config.riskPerTradePct,
      lotSize: config.lotSize,
      maxSinglePositionPct: config.maxSinglePositionPct,
      broker: config.broker,
      tradeDate: ctx.signalDate,
    });

    if (sized.position === null) {
      reject(stock.code, sized.rejectReason!, sized.detail);
      continue;
    }

    // 總曝險：依排名順序累加，額度先給名次高的
    if (exposurePct + sized.position.positionPct > config.maxTotalExposurePct) {
      reject(
        stock.code,
        'total_exposure_cap',
        `再加這 ${sized.position.positionPct.toFixed(1)}% 會讓總曝險達 ` +
          `${(exposurePct + sized.position.positionPct).toFixed(1)}%，超過上限 ${config.maxTotalExposurePct}%`,
      );
      continue;
    }

    approved.push({
      stock,
      barrier,
      position: sized.position,
      sigmaDaily: vol.sigmaDaily,
      volObservations: vol.observations,
    });
    exposurePct += sized.position.positionPct;
    openPositions += 1;
    entriesThisMonth += 1;
  }

  const result: RiskResult = {
    approved,
    rejected,
    countsByReason: counts,
    haltedGlobally: false,
    haltReason: null,
  };
  assertOnlySubtracts(candidates, result);
  return result;
}

/**
 * 實際驗證「只減不增」。每次執行都會跑，不只在測試裡。
 * L3 的輸出是帶部位的新物件，故比對代號而非物件本身。
 */
export function assertOnlySubtracts(
  input: readonly RankedStock[],
  result: RiskResult,
): void {
  if (result.approved.length > input.length) {
    throw new RiskLayerViolationError(
      `核准數 ${result.approved.length} 大於輸入數 ${input.length}`,
    );
  }

  const inputCodes = new Set(input.map((s) => s.code));
  const seen = new Set<string>();
  for (const signal of result.approved) {
    if (!inputCodes.has(signal.stock.code)) {
      throw new RiskLayerViolationError(
        `核准清單中的 ${signal.stock.code} 不在輸入清單裡（L3 不得產生新標的）`,
      );
    }
    if (seen.has(signal.stock.code)) {
      throw new RiskLayerViolationError(`${signal.stock.code} 在核准清單中重複出現`);
    }
    seen.add(signal.stock.code);
  }

  const rejectedCodes = new Set(result.rejected.map((r) => r.code));
  if (result.approved.length + rejectedCodes.size !== input.length) {
    throw new RiskLayerViolationError(
      `核准 ${result.approved.length} + 被拒 ${rejectedCodes.size} ≠ 輸入 ${input.length}，有標的憑空消失或出現`,
    );
  }
}
