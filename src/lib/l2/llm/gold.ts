/**
 * P11 — 對 gold_set 評分。純函式。
 *
 * 【只看總正確率會被騙，所以這裡永遠同時算 baseline】
 * 重大訊息絕大多數是例行公告。假設 100 題裡只有 8 題該否決，
 * 一個永遠回 no_veto 的「模型」正確率就有 92%——聽起來很強，實際毫無作用。
 * 因此每次評分都一併算出 **always-no_veto baseline**，
 * 任何模型必須勝過它才算有貢獻。這不是額外的嚴格，是最低限度的誠實。
 *
 * 【漏擋與誤擋分開記，因為代價不同】
 *   - 漏擋 false_negative：該否決卻放行 → 進了不該進的場
 *   - 誤擋 false_positive：不該否決卻擋下 → 錯過機會
 * 兩者不可互相抵銷。只報一個總分，等於允許用一堆誤擋去換一次漏擋的改善。
 *
 * 【gold_set_hash：不同考卷不能比成績】
 * 考題換了，分數就沒有可比性。雜湊納入每一題的 item_key 與標準答案，
 * 任何增刪或重標都會讓雜湊改變，晉升判定據此拒絕跨考卷比較。
 */

import { createHash } from 'node:crypto';

import type { GoldItem, LlmVerdict, Verdict } from './types';

/** CLAUDE.md：樣本 < 30 筆不得下結論 */
export const MIN_GOLD_SAMPLE = 30;

export interface GoldScore {
  /** 實際評到的題數（只算模型有回答的） */
  readonly n: number;
  readonly correct: number;
  readonly accuracy: number;
  /** 該否決卻放行 */
  readonly falseNegatives: number;
  /** 不該否決卻擋下 */
  readonly falsePositives: number;
  /** 標準答案為 veto 的題數，判斷這份考卷有沒有鑑別度 */
  readonly vetoLabels: number;
  /** 回應解析失敗的題數 */
  readonly parseFailures: number;
  /** 判否決但引用驗不過而被作廢的題數 */
  readonly evidenceFailures: number;
}

/**
 * 「永遠回 no_veto」的對照組。
 * 它不需要任何模型、不需要電、不會出錯，是所有模型的下限。
 */
export function baselineScore(items: readonly GoldItem[]): GoldScore {
  const vetoLabels = items.filter((i) => i.label === 'veto').length;
  const n = items.length;
  return {
    n,
    correct: n - vetoLabels,
    accuracy: n === 0 ? 0 : (n - vetoLabels) / n,
    falseNegatives: vetoLabels,
    falsePositives: 0,
    vetoLabels,
    parseFailures: 0,
    evidenceFailures: 0,
  };
}

/**
 * 對照標準答案評分。
 *
 * 只評「模型有回答的題目」。沒有結果的題目不算對也不算錯——
 * 把沒答的當答對會讓成績虛高，當答錯則會讓一次連線失敗毀掉整份評分。
 * 未作答的題數由呼叫端另外回報。
 */
export function scoreAgainstGold(
  items: readonly GoldItem[],
  verdictsByTaskKey: ReadonlyMap<string, LlmVerdict>,
): GoldScore {
  let correct = 0;
  let falseNegatives = 0;
  let falsePositives = 0;
  let parseFailures = 0;
  let evidenceFailures = 0;
  let n = 0;
  let vetoLabels = 0;

  for (const item of items) {
    if (item.label === 'veto') {
      vetoLabels += 1;
    }
    const result = verdictsByTaskKey.get(item.itemKey);
    if (result === undefined) {
      continue;
    }
    n += 1;
    if (!result.parseOk) {
      parseFailures += 1;
    }
    if (result.parseOk && !result.evidenceVerified) {
      evidenceFailures += 1;
    }
    if (result.verdict === item.label) {
      correct += 1;
    } else if (item.label === 'veto') {
      falseNegatives += 1;
    } else {
      falsePositives += 1;
    }
  }

  return {
    n,
    correct,
    accuracy: n === 0 ? 0 : correct / n,
    falseNegatives,
    falsePositives,
    vetoLabels,
    parseFailures,
    evidenceFailures,
  };
}

/**
 * 考卷的雜湊。納入每一題的 item_key 與標準答案，先排序以確保順序無關。
 * 增加一題、刪掉一題、或把某題重標，雜湊都會變。
 */
export function goldSetHash(items: readonly GoldItem[]): string {
  const canonical = items
    .map((i) => `${i.itemKey}=${i.label}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** 把同一 item_key 的多個 revision 收斂成最新的那一版 */
export function latestRevisions(items: readonly GoldItem[]): readonly GoldItem[] {
  const best = new Map<string, GoldItem>();
  for (const item of items) {
    const current = best.get(item.itemKey);
    if (current === undefined || item.revision > current.revision) {
      best.set(item.itemKey, item);
    }
  }
  return [...best.values()].sort((a, b) => (a.itemKey < b.itemKey ? -1 : 1));
}

/** 一份考卷有沒有鑑別度：全是同一個答案的考卷，考幾分都沒有意義 */
export function isDegenerate(items: readonly GoldItem[]): boolean {
  const labels = new Set<Verdict>(items.map((i) => i.label));
  return labels.size < 2;
}
