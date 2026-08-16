/**
 * 橫斷面評分的統計基礎。純函式，無 I/O，無隨機性。
 *
 * 【為什麼用名次而不是用原始值加總】
 * 五個因子的單位完全不同：年增率是百分比、買超比重是無單位小數、
 * 融資增減率又是另一個尺度。直接相加等於憑數字大小隨便給權重。
 * 轉成名次後每個因子都落在 0～1，等權平均才有意義，且不需要任何權重參數。
 *
 * 【平手一律給平均名次（midrank）】
 * 台股每天有大量個股的投信買超為 0。若用一般排序，這些平手的股票
 * 會依「陣列裡誰先出現」決定先後 —— 那是隱藏的隨機參數，
 * 換一個資料來源順序，Top 5 就變了。平均名次讓平手者拿到完全相同的分數。
 *
 * 【分位數用 type 7】
 * 這是 numpy / pandas 的預設定義。P12 的因子檢定跑在 Python 端，
 * 兩邊用同一個定義，縮尾結果才會一致，不會出現「TS 算的和 Python 算的不同」。
 */

import type { HypothesisDirection } from '../../factors/types';

/** 平手時所有人共用的名次差距容忍值：完全相等才算平手，不做浮點近似。 */

/**
 * type 7 分位數（numpy.percentile / pandas.quantile 預設）。
 * @param sortedAsc 已升冪排序且不含 NaN 的陣列
 * @param pct 0～100
 */
export function quantileType7(sortedAsc: readonly number[], pct: number): number {
  const n = sortedAsc.length;
  if (n === 0) {
    throw new Error('quantileType7：空陣列沒有分位數');
  }
  if (n === 1) {
    return sortedAsc[0]!;
  }
  const h = ((n - 1) * pct) / 100;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const vLo = sortedAsc[lo]!;
  if (lo === hi) {
    return vLo;
  }
  return vLo + (h - lo) * (sortedAsc[hi]! - vLo);
}

/**
 * 上下縮尾（winsorize）：超出分位數的值夾到分位數，**不刪除該筆**。
 *
 * ⚠️ 縮尾對名次的實際效果（2026-08-16 由測試實證，先前寫的「完全沒有影響」是錯的）：
 * 縮尾是**非嚴格**單調轉換，故大小順序不變，但**會把超出分位數的極端值壓成平手**。
 * 以 1%／99% 縮尾套在約 1,500 檔的橫斷面上，最強的約 15 檔會拿到完全相同的滿分，
 * 最弱的約 15 檔同樣共用最低分。
 *
 * 這正是登記定義要的效果：不讓單一離群值獨佔名次頂端。
 * 對觀察榜的實際影響是 Top 5 常出現平手，此時由代號升冪決勝（規則寫死可重現）。
 * 縮尾後的值同時保留下來供 P12 的 t 檢定使用——那裡極端值會實質扭曲統計量。
 */
export function winsorize(
  values: readonly number[],
  lowerPct: number,
  upperPct: number,
): readonly number[] {
  if (values.length === 0) {
    return [];
  }
  const sorted = [...values].sort((a, b) => a - b);
  const lo = quantileType7(sorted, lowerPct);
  const hi = quantileType7(sorted, upperPct);
  return values.map((v) => (v < lo ? lo : v > hi ? hi : v));
}

/**
 * 升冪平均名次（1 起算）。平手者共用平均名次。
 *
 * 例：[10, 20, 20, 30] → [1, 2.5, 2.5, 4]
 */
export function midranksAscending(values: readonly number[]): readonly number[] {
  const n = values.length;
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]! || a - b);
  const ranks = new Array<number>(n);

  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]!] === values[order[i]!]) {
      j += 1;
    }
    // 1 起算的平均名次
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) {
      ranks[order[k]!] = avg;
    }
    i = j + 1;
  }
  return ranks;
}

/**
 * 名次 → 0～1 分數，並依事先登記的假設方向決定高低。
 *
 * `lower_is_better` 的因子（融資增幅、五日漲幅）數值越小分數越高。
 * 方向來自 factor_registry 的登記內容，**不是計算時才決定**。
 *
 * 只有一檔時回 0.5：一檔股票沒有橫斷面可言，給中性值而不是滿分。
 */
export function ranksToScores(
  midranks: readonly number[],
  direction: HypothesisDirection,
): readonly number[] {
  const n = midranks.length;
  if (n === 0) {
    return [];
  }
  if (n === 1) {
    return [0.5];
  }
  return midranks.map((r) => {
    const ascending = (r - 1) / (n - 1);
    return direction === 'higher_is_better' ? ascending : 1 - ascending;
  });
}

/** 一次做完縮尾 → 名次 → 分數 */
export interface ScoredValues {
  /** 與輸入等長：縮尾後的值 */
  readonly winsorized: readonly number[];
  /** 與輸入等長：0～1 分數，已套用假設方向 */
  readonly scores: readonly number[];
}

export function scoreCrossSection(
  values: readonly number[],
  direction: HypothesisDirection,
  lowerPct: number,
  upperPct: number,
): ScoredValues {
  const winsorized = winsorize(values, lowerPct, upperPct);
  const scores = ranksToScores(midranksAscending(winsorized), direction);
  return { winsorized, scores };
}
