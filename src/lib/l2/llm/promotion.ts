/**
 * P11 — Champion / Challenger 晉升判定。純函式。
 *
 * 【CLAUDE.md：❌ 禁止熱抽換】
 * 新模型不會因為「看起來比較新」「參數比較大」就上線。
 * 它必須跟現役模型考同一份 gold_set，成績勝出才晉升，
 * 而且切換時點寫入 model_registry，歷史日誌永遠可回溯由哪個模型產生。
 *
 * 【五道門檻，任一不過即拒絕】
 *   1. 樣本 ≥ 30（CLAUDE.md：樣本 < 30 筆不得下結論）
 *   2. 兩者考的是同一份考卷（gold_set_hash 相同）
 *   3. 勝過 always-no_veto baseline —— 沒有這條，一個什麼都不擋的模型也能上線
 *   4. 正確率**嚴格**高於 champion —— 平手不換，換代本身就有風險
 *   5. 漏擋數不得增加 —— 用一堆漏擋去換總正確率，是最危險的一種「進步」
 *
 * 【第一任 champion 也要考】
 * 沒有現役模型時，第 1、2、3 條依然適用。
 * 「反正還沒有 champion」不是讓一個沒考過的模型直接上線的理由。
 */

import type { GoldScore } from './gold';
import { MIN_GOLD_SAMPLE } from './gold';

export interface PromotionInput {
  readonly challenger: GoldScore;
  readonly challengerGoldSetHash: string;
  /** 現役模型的成績。第一任時為 null */
  readonly champion: GoldScore | null;
  /** 現役模型考的那份考卷。第一任時為 null */
  readonly championGoldSetHash: string | null;
  readonly baseline: GoldScore;
}

export interface PromotionDecision {
  readonly promote: boolean;
  /** 逐條門檻的結果，通過與否都列出來，不只列失敗的 */
  readonly checks: readonly { readonly name: string; readonly passed: boolean; readonly detail: string }[];
}

export function evaluatePromotion(input: PromotionInput): PromotionDecision {
  const { challenger, champion, baseline } = input;
  const checks: { name: string; passed: boolean; detail: string }[] = [];

  checks.push({
    name: `樣本數 ≥ ${MIN_GOLD_SAMPLE}`,
    passed: challenger.n >= MIN_GOLD_SAMPLE,
    detail: `challenger 實際作答 ${challenger.n} 題`,
  });

  const sameExam =
    input.championGoldSetHash === null || input.championGoldSetHash === input.challengerGoldSetHash;
  checks.push({
    name: '兩者考同一份 gold_set',
    passed: sameExam,
    detail: sameExam
      ? input.championGoldSetHash === null
        ? '尚無現役模型，不需比對考卷'
        : `考卷雜湊相同（${input.challengerGoldSetHash.slice(0, 12)}…）`
      : `考卷不同：champion ${(input.championGoldSetHash ?? '').slice(0, 12)}… vs ` +
        `challenger ${input.challengerGoldSetHash.slice(0, 12)}…，成績不可比`,
  });

  const beatsBaseline = challenger.accuracy > baseline.accuracy;
  checks.push({
    name: '勝過 always-no_veto baseline',
    passed: beatsBaseline,
    detail:
      `challenger ${(challenger.accuracy * 100).toFixed(1)}% vs ` +
      `baseline ${(baseline.accuracy * 100).toFixed(1)}%` +
      (beatsBaseline ? '' : '　（一個什麼都不擋的對照組都贏不了，這個模型沒有貢獻）'),
  });

  if (champion === null) {
    checks.push({
      name: '正確率高於現役模型',
      passed: true,
      detail: '尚無現役模型，此條不適用（前三條仍須通過）',
    });
    checks.push({ name: '漏擋數未增加', passed: true, detail: '尚無現役模型，此條不適用' });
  } else {
    const better = challenger.accuracy > champion.accuracy;
    checks.push({
      name: '正確率高於現役模型',
      passed: better,
      detail:
        `challenger ${(challenger.accuracy * 100).toFixed(1)}% vs ` +
        `champion ${(champion.accuracy * 100).toFixed(1)}%` +
        (better ? '' : '　（平手或落後一律不換代）'),
    });

    const noMoreMisses = challenger.falseNegatives <= champion.falseNegatives;
    checks.push({
      name: '漏擋數未增加',
      passed: noMoreMisses,
      detail:
        `challenger 漏擋 ${challenger.falseNegatives} vs champion ${champion.falseNegatives}` +
        (noMoreMisses ? '' : '　（總分變好但漏掉更多地雷，這不是進步）'),
    });
  }

  return { promote: checks.every((c) => c.passed), checks };
}
