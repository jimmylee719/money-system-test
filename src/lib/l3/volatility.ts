/**
 * 日報酬波動率估計。純函式。
 *
 * 【為什麼用 EWM 而不是簡單標準差】
 * CLAUDE.md：屏障用報酬 EWMA 動態調整，不用固定百分比。
 * 固定百分比停損在低波動股太寬、在高波動股太窄，等於對不同標的用不同嚴格度。
 * 以波動率標準化後，每一筆交易的 1R 才是同一件事，R 倍數才可跨標的比較。
 *
 * 【實作依 pandas `ewm(span=N).std()` 的**公開定義**：adjust=True、bias=False】
 * P12 的因子檢定跑在 Python 端，兩邊用同一個定義，數字才會一致——
 * 否則「TS 算的停損」和「Python 驗的停損」會是兩回事，而且不會有人發現。
 *
 * ⚠️ **尚未與實際的 pandas 交叉驗證**（2026-08-16：本機無可用的 Python）。
 *    目前只做到「依公開文件的公式實作，並以手算驗證公式本身」。
 *    P12 建 Python service 時必須實跑比對，通過之後才可宣稱兩邊一致。
 *
 * 【資料不足時回 null，不回退到預設值】
 * 猜一個波動率出來，會產生一個看起來很正常、實際毫無根據的停損價。
 * 那比沒有訊號危險得多。
 */

/**
 * 日對數報酬。
 *
 * 接受**與交易日對齊、缺值為 null** 的序列（停牌日該檔為 null）。
 * 只在**相鄰兩天皆有價格**時才算一筆報酬——
 * 若把跨越停牌的價差當成一日報酬，波動率會被高估，停損就會被設得太寬。
 */
export function logReturns(closes: readonly (number | null)[]): readonly number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const curr = closes[i];
    // 缺值或非正價格都不算成報酬 0 —— 那是資料缺口，不是「沒有漲跌」
    if (prev === null || curr === null || prev === undefined || curr === undefined) {
      continue;
    }
    if (prev <= 0 || curr <= 0) {
      continue;
    }
    out.push(Math.log(curr / prev));
  }
  return out;
}

/**
 * 指數加權標準差，對齊 pandas `ewm(span, adjust=True).std()`（bias=False）。
 *
 * 權重 wᵢ = (1−α)^(n−1−i)，α = 2/(span+1)，最新一筆權重最大。
 * 偏誤校正因子 = sumW² / (sumW² − sumW2)，與 pandas 相同。
 *
 * @returns 標準差；樣本不足 2 筆或校正因子無效時回 null
 */
export function ewmStd(values: readonly number[], span: number): number | null {
  const n = values.length;
  if (n < 2 || span < 1) {
    return null;
  }
  const alpha = 2 / (span + 1);
  const decay = 1 - alpha;

  let sumW = 0;
  let sumW2 = 0;
  let weightedSum = 0;
  for (let i = 0; i < n; i += 1) {
    const w = decay ** (n - 1 - i);
    sumW += w;
    sumW2 += w * w;
    weightedSum += w * values[i]!;
  }
  if (sumW === 0) {
    return null;
  }
  const mean = weightedSum / sumW;

  let weightedSqDev = 0;
  for (let i = 0; i < n; i += 1) {
    const w = decay ** (n - 1 - i);
    const dev = values[i]! - mean;
    weightedSqDev += w * dev * dev;
  }
  const biasedVar = weightedSqDev / sumW;

  // pandas 的偏誤校正：sumW² / (sumW² − sumW2)
  const denom = sumW * sumW - sumW2;
  if (denom <= 0) {
    return null;
  }
  const correction = (sumW * sumW) / denom;
  const variance = biasedVar * correction;
  return variance <= 0 ? null : Math.sqrt(variance);
}

export interface DailyVolatility {
  /** 日報酬標準差（小數，非百分比）。無法估計時為 null。 */
  readonly sigmaDaily: number | null;
  /** 實際用來估計的報酬筆數 */
  readonly observations: number;
  /** 無法估計時的原因，可直接寫進拒絕紀錄 */
  readonly reason: string | null;
}

/**
 * 由收盤價序列估日波動率。
 *
 * @param closes  依交易日升冪、與交易日對齊的收盤價（該日無資料為 null）
 * @param span    EWM 跨度
 * @param minObservations 最少報酬筆數；不足即回 null 並附原因
 */
export function estimateDailyVolatility(
  closes: readonly (number | null)[],
  span: number,
  minObservations: number,
): DailyVolatility {
  const returns = logReturns(closes);
  if (returns.length < minObservations) {
    return {
      sigmaDaily: null,
      observations: returns.length,
      reason:
        `波動率估計需要 ${minObservations} 筆日報酬（約 ${minObservations + 1} 個交易日），` +
        `目前只有 ${returns.length} 筆`,
    };
  }
  const sigma = ewmStd(returns, span);
  if (sigma === null || !Number.isFinite(sigma) || sigma <= 0) {
    return {
      sigmaDaily: null,
      observations: returns.length,
      reason: '報酬序列算不出有效的標準差（可能全為零或含異常值）',
    };
  }
  return { sigmaDaily: sigma, observations: returns.length, reason: null };
}
