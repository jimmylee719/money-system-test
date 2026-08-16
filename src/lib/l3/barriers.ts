/**
 * 三屏障（Triple Barrier）。純函式。
 *
 * 【三道屏障必須在進場前同時寫死】（CLAUDE.md，不可簡化）
 *   停損   = 1R，由波動率決定，不是固定百分比
 *   停利   ≥ 2R
 *   時間出場 N 個交易日未觸發即平倉 —— 這是資金週轉引擎，不是預測
 *
 * 【為什麼不能用「獲利就賣」】（CLAUDE.md 明文禁止）
 * 賺一點就跑會壓縮平均獲利，而虧損那端沒有對應的上限，
 * 期望值因此系統性地被拉負；套牢的部位還會鎖死資金，讓後面的訊號無法執行。
 * 所以停利必須是 R 的倍數，且與停損同時決定。
 *
 * 【停損距離用 σ√N 而不是 σ】
 * 屏障要撐過整個持有期間，不是只撐一天。在隨機漫步近似下，
 * N 日累積報酬的標準差 ≈ 日波動 × √N。用日波動當停損距離，
 * 等於幾乎必然在持有期內被雜訊掃出場。
 */

export interface BarrierInput {
  readonly entryPrice: number;
  /** 日報酬標準差（小數） */
  readonly sigmaDaily: number;
  readonly holdingDays: number;
  readonly stopSigmaMultiple: number;
  readonly takeProfitR: number;
}

export interface TripleBarrier {
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly takeProfitPrice: number;
  /** 時間出場：N 個交易日 */
  readonly timeExitDays: number;
  /** 每股風險 = 進場價 − 停損價，即 1R */
  readonly riskPerShare: number;
  /** 停損距離佔進場價的比例（小數） */
  readonly stopDistancePct: number;
}

export class BarrierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BarrierError';
  }
}

export function computeBarriers(input: BarrierInput): TripleBarrier {
  const { entryPrice, sigmaDaily, holdingDays, stopSigmaMultiple, takeProfitR } = input;

  if (entryPrice <= 0) {
    throw new BarrierError('進場價必須為正數');
  }
  if (sigmaDaily <= 0 || !Number.isFinite(sigmaDaily)) {
    throw new BarrierError('日波動率必須為正數 —— 估不出來時應拒絕出訊號，而不是傳 0 進來');
  }
  if (holdingDays < 1) {
    throw new BarrierError('持有天數必須 ≥ 1');
  }

  // 1R = 停損倍數 × 日波動 × √N
  const stopDistancePct = stopSigmaMultiple * sigmaDaily * Math.sqrt(holdingDays);

  if (stopDistancePct >= 1) {
    // 停損距離超過 100% 代表波動率高到停損價會是負數，此標的不可交易
    throw new BarrierError(
      `停損距離 ${(stopDistancePct * 100).toFixed(1)}% 超過 100%，此標的波動過大無法設定屏障`,
    );
  }

  const riskPerShare = entryPrice * stopDistancePct;
  const stopPrice = entryPrice - riskPerShare;
  const takeProfitPrice = entryPrice + takeProfitR * riskPerShare;

  return {
    entryPrice,
    stopPrice,
    takeProfitPrice,
    timeExitDays: holdingDays,
    riskPerShare,
    stopDistancePct,
  };
}
