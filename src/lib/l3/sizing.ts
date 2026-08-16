/**
 * 部位大小。純函式。
 *
 * 【公式來自 CLAUDE.md，不得改寫】
 *   股數 = (總資金 × r) ÷ (進場價 − 停損價)
 * 分母就是 1R。這代表**每一筆交易的最大虧損都相同**，
 * 與股價高低、與看好程度都無關——「看好就多買」正是爆倉的標準路徑。
 *
 * 【只買整張】
 * 台股一張 1000 股。零股另有流動性與成本問題，且 CLAUDE.md 禁止零股沖銷。
 * 算出來不到 1 張就是**拒絕進場**，不是四捨五入成 1 張——
 * 湊成 1 張會讓實際風險超過設定的 r，那就不是硬上限了。
 *
 * 【成本必須真的算過】
 * 停利價若連損益兩平都沒到，這筆交易在數學上不可能賺錢。
 * 用 P0 的成本模組實算，而不是估一個「大概 0.6%」。
 */

import { calcTradeOutcome } from '../cost/cost';
import type { BrokerFeeConfig, TradeOutcome } from '../cost/types';
import type { TripleBarrier } from './barriers';

export interface SizingInput {
  readonly barrier: TripleBarrier;
  readonly equityTwd: number;
  readonly riskPerTradePct: number;
  readonly lotSize: number;
  readonly maxSinglePositionPct: number;
  readonly broker: BrokerFeeConfig;
  /** 交易日 'YYYY-MM-DD'。稅率隨法規施行期間變動，不可用「今天」推定。 */
  readonly tradeDate: string;
}

export interface SizedPosition {
  readonly lots: number;
  readonly shares: number;
  /** 部位金額 = 股數 × 進場價 */
  readonly positionValueTwd: number;
  /** 名目風險 = 股數 × 每股風險。應 ≤ 總資金 × r。 */
  readonly riskAmountTwd: number;
  /** 部位金額佔總資金比例（%） */
  readonly positionPct: number;
  /** 扣成本後的實際損益與 R 倍數 */
  readonly outcome: TradeOutcome;
}

export type SizingRejectReason =
  | 'below_one_lot'
  | 'exceeds_single_position_cap'
  | 'target_below_breakeven';

export interface SizingResult {
  readonly position: SizedPosition | null;
  readonly rejectReason: SizingRejectReason | null;
  readonly detail: string;
}

export function sizePosition(input: SizingInput): SizingResult {
  const { barrier, equityTwd, riskPerTradePct, lotSize, maxSinglePositionPct, broker, tradeDate } =
    input;

  const riskBudget = (equityTwd * riskPerTradePct) / 100;
  const rawShares = riskBudget / barrier.riskPerShare;
  const lots = Math.floor(rawShares / lotSize);

  if (lots < 1) {
    return {
      position: null,
      rejectReason: 'below_one_lot',
      detail:
        `風險預算 ${Math.round(riskBudget).toLocaleString()} 元 ÷ 每股風險 ` +
        `${barrier.riskPerShare.toFixed(2)} 元 = ${rawShares.toFixed(0)} 股，不足 1 張（${lotSize} 股）。` +
        '湊成 1 張會讓實際風險超過設定上限，故拒絕。',
    };
  }

  const shares = lots * lotSize;
  const positionValueTwd = shares * barrier.entryPrice;
  const positionPct = (positionValueTwd / equityTwd) * 100;

  if (positionPct > maxSinglePositionPct) {
    return {
      position: null,
      rejectReason: 'exceeds_single_position_cap',
      detail:
        `${lots} 張 = ${Math.round(positionValueTwd).toLocaleString()} 元，` +
        `佔總資金 ${positionPct.toFixed(1)}%，超過單一部位上限 ${maxSinglePositionPct}%。` +
        '（低波動股的停損距離短，部位公式會算出極大張數，此上限即為此而設）',
    };
  }

  // 實算成本：停利價若沒到損益兩平，這筆交易數學上不可能賺錢
  const outcome = calcTradeOutcome({
    entryPrice: barrier.entryPrice.toFixed(2),
    shares,
    // 波段持有數日至兩週，證交稅為一般稅率 3‰，非當沖減半
    tradeType: 'normal',
    broker,
    tradeDate,
    stopLossPrice: barrier.stopPrice.toFixed(2),
    takeProfitPrice: barrier.takeProfitPrice.toFixed(2),
  });

  if (outcome.takeProfit.netPnl.cents <= 0n) {
    return {
      position: null,
      rejectReason: 'target_below_breakeven',
      detail:
        `停利價 ${barrier.takeProfitPrice.toFixed(2)} 扣掉手續費與證交稅後淨損益為 ` +
        `${outcome.takeProfit.netPnl.twd} 元，未達損益兩平。這筆交易不可能獲利。`,
    };
  }

  return {
    position: {
      lots,
      shares,
      positionValueTwd,
      riskAmountTwd: shares * barrier.riskPerShare,
      positionPct,
      outcome,
    },
    rejectReason: null,
    detail:
      `${lots} 張（${shares} 股）｜部位 ${Math.round(positionValueTwd).toLocaleString()} 元` +
      `（${positionPct.toFixed(1)}%）｜名目風險 ${Math.round(shares * barrier.riskPerShare).toLocaleString()} 元` +
      `｜停利淨 R = ${outcome.takeProfit.rMultiple.toFixed(2)}`,
  };
}
