import { describe, expect, it } from 'vitest';

import {
  MIN_GOLD_SAMPLE,
  baselineScore,
  goldSetHash,
  isDegenerate,
  latestRevisions,
  scoreAgainstGold,
} from '../gold';
import { evaluatePromotion } from '../promotion';
import type { GoldItem, LlmVerdict, Verdict } from '../types';

function goldItem(n: number, label: Verdict, revision = 1): GoldItem {
  return {
    sourceId: 'mops_twse_material_announcements',
    code: String(1000 + n),
    market: 'TWSE',
    speakDate: '2026-08-15',
    clause: '第51款',
    subject: `主旨 ${n}`,
    detail: `說明 ${n}`,
    contentHash: String(n).padStart(64, '0'),
    itemKey: `TWSE:${1000 + n}:2026-08-15:${String(n).padStart(12, '0')}`,
    label,
    labelReason: '測試用',
    labeledBy: 'test',
    revision,
  };
}

function verdictFor(item: GoldItem, verdict: Verdict, extra: Partial<LlmVerdict> = {}): LlmVerdict {
  return {
    taskKey: item.itemKey,
    verdict,
    quotedEvidence: verdict === 'veto' ? '原文片段' : '',
    evidenceVerified: true,
    parseOk: true,
    reason: '',
    rawResponse: '',
    latencyMs: 1,
    ...extra,
  };
}

/** 100 題中 8 題該否決——重大訊息實際的分布就是極度不平衡 */
const SKEWED: readonly GoldItem[] = [
  ...Array.from({ length: 8 }, (_, i) => goldItem(i, 'veto')),
  ...Array.from({ length: 92 }, (_, i) => goldItem(100 + i, 'no_veto')),
];

describe('baselineScore — 永遠回 no_veto 的對照組', () => {
  it('在不平衡的考卷上正確率高達 92%，這正是總正確率會騙人的原因', () => {
    const base = baselineScore(SKEWED);
    expect(base.n).toBe(100);
    expect(base.accuracy).toBeCloseTo(0.92, 10);
    expect(base.falseNegatives).toBe(8); // 八顆地雷全踩
    expect(base.falsePositives).toBe(0);
  });
});

describe('scoreAgainstGold', () => {
  it('漏擋與誤擋分開計，不互相抵銷', () => {
    const map = new Map<string, LlmVerdict>();
    // 8 題該否決中答對 5 題、漏 3 題；92 題不該否決中誤擋 4 題
    SKEWED.forEach((item, index) => {
      if (item.label === 'veto') {
        map.set(item.itemKey, verdictFor(item, index < 5 ? 'veto' : 'no_veto'));
      } else {
        map.set(item.itemKey, verdictFor(item, index < 8 + 4 ? 'veto' : 'no_veto'));
      }
    });
    const score = scoreAgainstGold(SKEWED, map);
    expect(score.n).toBe(100);
    expect(score.falseNegatives).toBe(3);
    expect(score.falsePositives).toBe(4);
    expect(score.correct).toBe(93);
    expect(score.accuracy).toBeCloseTo(0.93, 10);
    expect(score.vetoLabels).toBe(8);
  });

  it('沒有結果的題目不算對也不算錯', () => {
    const map = new Map<string, LlmVerdict>();
    const answered = SKEWED.slice(0, 10);
    for (const item of answered) {
      map.set(item.itemKey, verdictFor(item, item.label));
    }
    const score = scoreAgainstGold(SKEWED, map);
    expect(score.n).toBe(10);
    expect(score.accuracy).toBe(1);
    // 未作答的 90 題既沒讓分數變好也沒變壞
    expect(score.correct).toBe(10);
  });

  it('解析失敗與引用作廢分別計數', () => {
    const items = [goldItem(1, 'veto'), goldItem(2, 'no_veto'), goldItem(3, 'no_veto')];
    const map = new Map<string, LlmVerdict>([
      [items[0]!.itemKey, verdictFor(items[0]!, 'no_veto', { parseOk: false, evidenceVerified: false })],
      [items[1]!.itemKey, verdictFor(items[1]!, 'no_veto', { parseOk: true, evidenceVerified: false })],
      [items[2]!.itemKey, verdictFor(items[2]!, 'no_veto')],
    ]);
    const score = scoreAgainstGold(items, map);
    expect(score.parseFailures).toBe(1);
    expect(score.evidenceFailures).toBe(1);
    expect(score.falseNegatives).toBe(1);
  });
});

describe('goldSetHash — 考卷變了雜湊就變', () => {
  const items = [goldItem(1, 'veto'), goldItem(2, 'no_veto')];

  it('順序不影響雜湊', () => {
    expect(goldSetHash(items)).toBe(goldSetHash([...items].reverse()));
  });

  it('重標一題就換一份考卷', () => {
    const relabeled = [goldItem(1, 'no_veto'), goldItem(2, 'no_veto')];
    expect(goldSetHash(relabeled)).not.toBe(goldSetHash(items));
  });

  it('多一題就換一份考卷', () => {
    expect(goldSetHash([...items, goldItem(3, 'veto')])).not.toBe(goldSetHash(items));
  });
});

describe('latestRevisions / isDegenerate', () => {
  it('同一題只留最新 revision', () => {
    const kept = latestRevisions([goldItem(1, 'veto', 1), goldItem(1, 'no_veto', 2)]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.label).toBe('no_veto');
  });

  it('全是同一個答案的考卷沒有鑑別度', () => {
    expect(isDegenerate([goldItem(1, 'no_veto'), goldItem(2, 'no_veto')])).toBe(true);
    expect(isDegenerate([goldItem(1, 'veto'), goldItem(2, 'no_veto')])).toBe(false);
  });
});

describe('evaluatePromotion — 禁止熱抽換', () => {
  const hash = goldSetHash(SKEWED);
  const baseline = baselineScore(SKEWED);

  function score(over: Partial<ReturnType<typeof baselineScore>>) {
    return { ...baseline, ...over };
  }

  it('樣本不足 30 一律拒絕，即使成績很好', () => {
    const decision = evaluatePromotion({
      challenger: score({ n: 29, accuracy: 1, correct: 29, falseNegatives: 0 }),
      challengerGoldSetHash: hash,
      champion: null,
      championGoldSetHash: null,
      baseline,
    });
    expect(decision.promote).toBe(false);
    expect(decision.checks.find((c) => c.name.includes('樣本'))?.passed).toBe(false);
  });

  it('贏不過 always-no_veto baseline 就不算有貢獻', () => {
    // 92% 正好等於 baseline，不是「勝過」
    const decision = evaluatePromotion({
      challenger: score({ n: 100, accuracy: 0.92, correct: 92, falseNegatives: 8 }),
      challengerGoldSetHash: hash,
      champion: null,
      championGoldSetHash: null,
      baseline,
    });
    expect(decision.promote).toBe(false);
    expect(decision.checks.find((c) => c.name.includes('baseline'))?.passed).toBe(false);
  });

  it('第一任 champion 只要通過前三條就晉升', () => {
    const decision = evaluatePromotion({
      challenger: score({ n: 100, accuracy: 0.95, correct: 95, falseNegatives: 2, falsePositives: 3 }),
      challengerGoldSetHash: hash,
      champion: null,
      championGoldSetHash: null,
      baseline,
    });
    expect(decision.promote).toBe(true);
  });

  it('考卷不同就不准比成績', () => {
    const decision = evaluatePromotion({
      challenger: score({ n: 100, accuracy: 0.99, correct: 99, falseNegatives: 0 }),
      challengerGoldSetHash: hash,
      champion: score({ n: 100, accuracy: 0.95, correct: 95, falseNegatives: 2 }),
      championGoldSetHash: 'f'.repeat(64),
      baseline,
    });
    expect(decision.promote).toBe(false);
    expect(decision.checks.find((c) => c.name.includes('同一份'))?.passed).toBe(false);
  });

  it('平手不換代', () => {
    const same = score({ n: 100, accuracy: 0.95, correct: 95, falseNegatives: 2 });
    const decision = evaluatePromotion({
      challenger: same,
      challengerGoldSetHash: hash,
      champion: same,
      championGoldSetHash: hash,
      baseline,
    });
    expect(decision.promote).toBe(false);
  });

  it('總正確率變好但漏擋變多 → 拒絕。這是最危險的一種「進步」', () => {
    const decision = evaluatePromotion({
      challenger: score({ n: 100, accuracy: 0.97, correct: 97, falseNegatives: 6, falsePositives: 0 }),
      challengerGoldSetHash: hash,
      champion: score({ n: 100, accuracy: 0.95, correct: 95, falseNegatives: 2, falsePositives: 3 }),
      championGoldSetHash: hash,
      baseline,
    });
    expect(decision.promote).toBe(false);
    expect(decision.checks.find((c) => c.name.includes('漏擋'))?.passed).toBe(false);
    // 正確率那條確實是通過的——證明它是被漏擋這條單獨擋下的
    expect(decision.checks.find((c) => c.name.includes('正確率'))?.passed).toBe(true);
  });

  it('正確率提高且漏擋未增加 → 晉升', () => {
    const decision = evaluatePromotion({
      challenger: score({ n: 100, accuracy: 0.97, correct: 97, falseNegatives: 2, falsePositives: 1 }),
      challengerGoldSetHash: hash,
      champion: score({ n: 100, accuracy: 0.95, correct: 95, falseNegatives: 2, falsePositives: 3 }),
      championGoldSetHash: hash,
      baseline,
    });
    expect(decision.promote).toBe(true);
    expect(decision.checks.every((c) => c.passed)).toBe(true);
  });

  it(`MIN_GOLD_SAMPLE 與 CLAUDE.md 的「樣本 < 30 不下結論」一致`, () => {
    expect(MIN_GOLD_SAMPLE).toBe(30);
  });
});
