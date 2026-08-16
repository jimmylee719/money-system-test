/**
 * 部位大小。純函式。
 *
 * 【公式來自 CLAUDE.md，不得改寫】
 *   股數 = (總資金 × r) ÷ (進場價 − 停損價)
 * 分母就是 1R。這代表**每一筆交易的最大虧損都相同**，
 * 與股價高低、與看好程度都無關——「看好就多買」正是爆倉的標準路徑。
 *
 * 【⚠️ 2026-08-16 修正：公式必須把成本算進去，否則 r 不是硬上限】
 * 停損觸發時實際虧的是「名目風險 **＋** 來回手續費與證交稅」。
 * v1 的寫法只用名目風險反解股數，結果每一筆的實際虧損都超出預算：
 *   本金 10 萬、預算 1,000 元 → 買 158 股 → 停損實虧 1,059 元（超出 6%）
 * 部位越小，固定的最低手續費佔比越高，超出得越多。
 * 現在改為反解「名目風險 + 成本 ≤ 預算」的最大股數，r 才真的是上限。
 *
 * 【下單單位由設定決定，不寫死】
 * lotSize=1 允許零股、1000 只買整張。算出來不足一個單位就拒絕進場，
 * 不是無條件進位——湊上去會讓實際風險超過 r。
 *
 * 【賠率必須大於 1:1】
 * 我們目前沒有任何證據宣稱勝率高於 50%（因子檢定要到 2027-02 才有結論）。
 * 在沒有勝率證據的前提下，停利實得若小於停損實虧，就是負期望，該筆不做。
 * 這不是挑一個門檻，是「沒有勝率證據時賠率至少要對等」的必然結果。
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
  | 'target_below_breakeven'
  | 'odds_below_one';

export interface SizingResult {
  readonly position: SizedPosition | null;
  readonly rejectReason: SizingRejectReason | null;
  readonly detail: string;
}

/** 依 lotSize 向下取整到可下單的股數 */
function floorToLot(shares: number, lotSize: number): number {
  return Math.floor(shares / lotSize) * lotSize;
}

/**
 * 反解「名目風險 + 來回成本 ≤ 風險預算」的最大股數。
 *
 * 成本是階梯函數（最低手續費 20 元、元以下捨去），沒有解析解。
 * 先用忽略成本的股數當上界，再依實算成本迭代收斂，最後逐單位向下確認。
 * 迭代次數有上限，收斂不了就回 0（拒絕），不會無窮迴圈。
 */
function solveSharesWithinRiskBudget(input: SizingInput, riskBudget: number): number {
  const { barrier, lotSize, broker, tradeDate } = input;

  const actualLoss = (shares: number): number => {
    const outcome = calcTradeOutcome({
      entryPrice: barrier.entryPrice.toFixed(2),
      shares,
      tradeType: 'normal',
      broker,
      tradeDate,
      stopLossPrice: barrier.stopPrice.toFixed(2),
      takeProfitPrice: barrier.takeProfitPrice.toFixed(2),
    });
    // netPnl 為負，取絕對值即為實際虧損
    return -Number(outcome.stopLoss.netPnl.twd);
  };

  let shares = floorToLot(riskBudget / barrier.riskPerShare, lotSize);

  for (let iteration = 0; iteration < 12 && shares >= lotSize; iteration += 1) {
    const loss = actualLoss(shares);
    if (loss <= riskBudget) {
      break;
    }
    const cost = loss - barrier.riskPerShare * shares;
    const next = floorToLot((riskBudget - cost) / barrier.riskPerShare, lotSize);
    if (next >= shares) {
      shares -= lotSize; // 收斂停滯時強制前進，避免無窮迴圈
    } else {
      shares = next;
    }
  }

  // 逐單位向下確認，確保回傳的股數確實在預算內
  while (shares >= lotSize && actualLoss(shares) > riskBudget) {
    shares -= lotSize;
  }
  return Math.max(shares, 0);
}

export function sizePosition(input: SizingInput): SizingResult {
  const { barrier, equityTwd, riskPerTradePct, lotSize, maxSinglePositionPct, broker, tradeDate } =
    input;

  const riskBudget = (equityTwd * riskPerTradePct) / 100;
  const shares = solveSharesWithinRiskBudget(input, riskBudget);

  if (shares < lotSize) {
    const naive = riskBudget / barrier.riskPerShare;
    return {
      position: null,
      rejectReason: 'below_one_lot',
      detail:
        `風險預算 ${Math.round(riskBudget).toLocaleString()} 元，每股風險 ` +
        `${barrier.riskPerShare.toFixed(2)} 元。不計成本可買 ${naive.toFixed(1)} 股，` +
        `但加上來回手續費與證交稅後，連 ${lotSize} 股都會讓實際虧損超出預算。` +
        '湊上去就不是硬上限了，故拒絕。',
    };
  }

  const lots = shares / lotSize;
  const positionValueTwd = shares * barrier.entryPrice;
  const positionPct = (positionValueTwd / equityTwd) * 100;

  const unitLabel = lotSize === 1 ? `${shares} 股` : `${lots} 張（${shares} 股）`;

  if (positionPct > maxSinglePositionPct) {
    return {
      position: null,
      rejectReason: 'exceeds_single_position_cap',
      detail:
        `${unitLabel} = ${Math.round(positionValueTwd).toLocaleString()} 元，` +
        `佔總資金 ${positionPct.toFixed(1)}%，超過單一部位上限 ${maxSinglePositionPct}%。` +
        '（低波動股的停損距離短，部位公式會算出極大部位，此上限即為此而設）',
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

  // 賠率必須 > 1:1。沒有勝率證據時，賠率低於 1:1 就是負期望。
  const netWin = Number(outcome.takeProfit.netPnl.twd);
  const netLoss = -Number(outcome.stopLoss.netPnl.twd);
  if (netWin <= netLoss) {
    return {
      position: null,
      rejectReason: 'odds_below_one',
      detail:
        `扣成本後停利實得 ${Math.round(netWin).toLocaleString()} 元、` +
        `停損實虧 ${Math.round(netLoss).toLocaleString()} 元，實際賠率 ` +
        `${(netWin / netLoss).toFixed(2)} : 1，低於 1 : 1。` +
        `部位僅 ${Math.round(positionValueTwd).toLocaleString()} 元，` +
        '固定的最低手續費把名目 2:1 的優勢吃光了。' +
        '在沒有勝率證據之前，賠率低於 1:1 即為負期望，故拒絕。',
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
      `${unitLabel}｜部位 ${Math.round(positionValueTwd).toLocaleString()} 元` +
      `（${positionPct.toFixed(1)}%）｜名目風險 ${Math.round(shares * barrier.riskPerShare).toLocaleString()} 元` +
      `｜實際賠率 ${(netWin / netLoss).toFixed(2)} : 1`,
  };
}
