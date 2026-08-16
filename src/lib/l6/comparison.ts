/**
 * 與 0050 的對照（G3 判準）。純函式。
 *
 * 【CLAUDE.md 的兩條紅線都寫在這裡】
 *   「樣本 < 30 筆不得下結論」→ 不足 30 筆時**不給結論**，只回報數字與狀態。
 *   「風險調整後淨報酬須勝過 0050」→ 只看平均超額報酬是不夠的，
 *     還要看那個超額有沒有穩定性（超額報酬的標準差）。
 *
 * 【為什麼不用勝率】
 * CLAUDE.md 明訂不採用勝率。10 次小贏 1 次大賠的策略勝率 91%，期望值卻是負的。
 * 這裡回報的是平均超額報酬與其離散度，不是「贏幾次」。
 * `beatCount` 有回報，但只當敘述性資訊，不作為判準。
 */

/** 一筆已對齊基準的觀察值 */
export interface MatchedObservation {
  readonly code: string;
  readonly dataAsOf: string;
  readonly exitDate: string;
  readonly horizon: number;
  /** 個股含息報酬（%） */
  readonly assetReturnPct: number;
  /** 0050 同期含息報酬（%）。null 代表基準缺價格，該筆不可比較。 */
  readonly benchmarkReturnPct: number | null;
}

export interface ExcessObservation extends MatchedObservation {
  readonly benchmarkReturnPct: number;
  /** 超額報酬（百分點）＝ 個股 − 基準 */
  readonly excessPct: number;
}

export type VerdictStatus =
  /** 樣本不足 30 筆，依 CLAUDE.md 不得下結論 */
  | 'insufficient_sample'
  /** 樣本足夠且平均超額為正 */
  | 'beats_benchmark'
  /** 樣本足夠但平均超額不為正 */
  | 'does_not_beat';

export interface ComparisonResult {
  readonly horizon: number;
  /** 可比較的觀察值數（基準缺價格者已排除） */
  readonly sampleSize: number;
  /** 因基準缺價格而無法比較的筆數 */
  readonly unmatched: number;
  readonly meanAssetPct: number;
  readonly meanBenchmarkPct: number;
  /** 平均超額報酬（百分點） */
  readonly meanExcessPct: number;
  /** 超額報酬的標準差（百分點），衡量穩定性 */
  readonly excessStdevPct: number;
  /**
   * 平均超額 ÷ 超額標準差。這是「風險調整後」的最小可行版本。
   * ⚠️ 這**不是** Deflated Sharpe Ratio。DSR 需連同試驗次數呈報，
   *    屬 P12 的工作。此處僅供觀察，不得單獨用來宣稱有效。
   */
  readonly excessMeanOverStdev: number | null;
  /** 超額為正的筆數。敘述性資訊，**不作為判準**（CLAUDE.md 不採用勝率）。 */
  readonly beatCount: number;
  readonly status: VerdictStatus;
  /** 給人看的一句話，會直接出現在報表上 */
  readonly verdict: string;
}

/** CLAUDE.md：樣本 < 30 筆不得下結論 */
export const MIN_SAMPLE_FOR_VERDICT = 30;

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

/** 樣本標準差（ddof=1）。少於 2 筆回 0。 */
function stdev(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

/** 篩出可比較的觀察值並算超額報酬 */
export function toExcessObservations(
  observations: readonly MatchedObservation[],
): readonly ExcessObservation[] {
  return observations
    .filter((o): o is MatchedObservation & { benchmarkReturnPct: number } =>
      o.benchmarkReturnPct !== null,
    )
    .map((o) => ({ ...o, excessPct: o.assetReturnPct - o.benchmarkReturnPct }));
}

export function compareToBenchmark(
  observations: readonly MatchedObservation[],
  horizon: number,
): ComparisonResult {
  const matched = toExcessObservations(observations);
  const unmatched = observations.length - matched.length;
  const excess = matched.map((o) => o.excessPct);
  const meanExcess = mean(excess);
  const sd = stdev(excess);

  const base = {
    horizon,
    sampleSize: matched.length,
    unmatched,
    meanAssetPct: mean(matched.map((o) => o.assetReturnPct)),
    meanBenchmarkPct: mean(matched.map((o) => o.benchmarkReturnPct)),
    meanExcessPct: meanExcess,
    excessStdevPct: sd,
    excessMeanOverStdev: sd > 0 ? meanExcess / sd : null,
    beatCount: excess.filter((e) => e > 0).length,
  };

  if (matched.length < MIN_SAMPLE_FOR_VERDICT) {
    return {
      ...base,
      status: 'insufficient_sample',
      verdict:
        `樣本 ${matched.length} 筆，未達 ${MIN_SAMPLE_FOR_VERDICT} 筆，**不下結論**` +
        '（CLAUDE.md：樣本 < 30 筆不得下結論）。數字僅供觀察。',
    };
  }

  return {
    ...base,
    status: meanExcess > 0 ? 'beats_benchmark' : 'does_not_beat',
    verdict:
      meanExcess > 0
        ? `平均每筆勝過 0050 ${meanExcess.toFixed(2)} 個百分點（${matched.length} 筆）。` +
          '⚠️ 這只是描述性結果，尚未做 Deflated Sharpe Ratio 與 Purged CV（P12）。'
        : `平均每筆輸給 0050 ${Math.abs(meanExcess).toFixed(2)} 個百分點（${matched.length} 筆）。` +
          '若持續如此，依 CLAUDE.md 此系統無存在價值。',
  };
}

/**
 * 觀察榜 vs 交易訊號的分開比較。
 *
 * 兩者的意義完全不同：
 *   觀察榜   純排序結果，不受 L2／L3 影響 → 衡量**因子排序**有沒有預測力
 *   交易訊號 通過 L2 否決與 L3 風控      → 衡量**整套系統**能不能執行
 * 若觀察榜勝過基準而交易訊號沒有，代表 L2／L3 在扣分，那是要修的地方。
 */
export interface SplitComparison {
  readonly watchlist: ComparisonResult;
  readonly tradeSignal: ComparisonResult;
  /** 兩者的差異解讀，直接寫給人看 */
  readonly interpretation: string;
}

export function compareSplit(
  watchlistObs: readonly MatchedObservation[],
  tradeSignalObs: readonly MatchedObservation[],
  horizon: number,
): SplitComparison {
  const watchlist = compareToBenchmark(watchlistObs, horizon);
  const tradeSignal = compareToBenchmark(tradeSignalObs, horizon);

  let interpretation: string;
  if (
    watchlist.status === 'insufficient_sample' ||
    tradeSignal.status === 'insufficient_sample'
  ) {
    interpretation = '兩份清單都還沒有足夠樣本，無法判斷 L2／L3 是加分還是扣分。';
  } else if (watchlist.meanExcessPct > 0 && tradeSignal.meanExcessPct <= 0) {
    interpretation =
      '排序本身勝過基準，但通過 L2／L3 之後反而輸了——' +
      '代表否決層或風控層把好的標的擋掉了，應檢視 veto_events 中被擋下的名次分布。';
  } else if (watchlist.meanExcessPct <= 0 && tradeSignal.meanExcessPct > 0) {
    interpretation = 'L2／L3 確實過濾掉了較差的標的，篩選是有效的。';
  } else if (watchlist.meanExcessPct > 0) {
    interpretation = '排序與整套系統都勝過基準。';
  } else {
    interpretation = '排序與整套系統都輸給基準。問題在 L1 的因子，不在 L2／L3。';
  }

  return { watchlist, tradeSignal, interpretation };
}
