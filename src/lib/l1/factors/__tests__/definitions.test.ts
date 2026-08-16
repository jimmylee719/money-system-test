import { describe, expect, it } from 'vitest';
import { hashDefinition } from '../../../factors/definition-hash';
import { validateRegistration } from '../../../factors/validation';
import {
  MIN_RATIONALE_LENGTH,
  MIN_T_THRESHOLD,
} from '../../../factors/validation';
import { T_THRESHOLD, TEST_PERIOD_END, TEST_PERIOD_START, V1_FACTORS } from '../definitions';

describe('v1 因子定義', () => {
  it('恰好 5 個 —— CLAUDE.md：v1 最多 5 個因子', () => {
    expect(V1_FACTORS).toHaveLength(5);
  });

  it('每一個都通過登記驗證（資料庫的 constraint 會再擋一次）', () => {
    for (const factor of V1_FACTORS) {
      expect(validateRegistration(factor), factor.factorKey).toEqual([]);
    }
  });

  it('factor_key 與 definition_hash 皆不重複', () => {
    const keys = V1_FACTORS.map((f) => f.factorKey);
    const hashes = V1_FACTORS.map((f) => hashDefinition(f.definition));
    expect(new Set(keys).size).toBe(5);
    expect(new Set(hashes).size).toBe(5);
  });

  it('門檻一律 t ≥ 3.0，不得逐因子放寬', () => {
    for (const factor of V1_FACTORS) {
      expect(factor.tThreshold, factor.factorKey).toBe(T_THRESHOLD);
      expect(factor.tThreshold).toBeGreaterThanOrEqual(MIN_T_THRESHOLD);
    }
  });

  it('檢定期間一致且為前瞻（無歷史資料可回測）', () => {
    for (const factor of V1_FACTORS) {
      expect(factor.testPeriodStart).toBe(TEST_PERIOD_START);
      expect(factor.testPeriodEnd).toBe(TEST_PERIOD_END);
    }
    // 檢定期間起點晚於 L0 開始累積的日期，故必為前瞻檢定
    expect(TEST_PERIOD_START > '2026-08-16').toBe(true);
  });

  it('假設方向必須事先宣告，且反向因子確實標為 lower_is_better', () => {
    const byKey = new Map(V1_FACTORS.map((f) => [f.factorKey, f]));
    expect(byKey.get('margin_balance_change_v1')?.hypothesisDirection).toBe('lower_is_better');
    expect(byKey.get('short_term_reversal_5d_v1')?.hypothesisDirection).toBe('lower_is_better');
    expect(byKey.get('trust_net_buy_ratio_v1')?.hypothesisDirection).toBe('higher_is_better');
    expect(byKey.get('rev_yoy_momentum_v1')?.hypothesisDirection).toBe('higher_is_better');
    expect(byKey.get('foreign_net_buy_ratio_v1')?.hypothesisDirection).toBe('higher_is_better');
  });

  it('經濟理由是真的說明機制，不是敷衍湊字數', () => {
    for (const factor of V1_FACTORS) {
      expect(factor.economicRationale.length, factor.factorKey).toBeGreaterThanOrEqual(
        MIN_RATIONALE_LENGTH,
      );
      // 每一段理由都必須說出「為什麼會這樣」，而不只是「這樣有效」
      expect(factor.economicRationale, factor.factorKey).toMatch(
        /因為|因此|故|源於|意味|反映|由於|導致|使得/,
      );
    }
  });

  it('定義含去極端值與資料有效性條件，不留調參空間', () => {
    for (const factor of V1_FACTORS) {
      const def = factor.definition as Record<string, unknown>;
      expect(def['winsorize'], factor.factorKey).toEqual({ lower_pct: 1, upper_pct: 99 });
      expect(Array.isArray(def['validity']), factor.factorKey).toBe(true);
      expect(def['spec_version']).toBe(1);
    }
  });

  it('定義雜湊對鍵值順序不敏感，對任何參數變動敏感', () => {
    const factor = V1_FACTORS[1]!;
    const original = hashDefinition(factor.definition);
    const reordered = hashDefinition(
      Object.fromEntries(Object.entries(factor.definition).reverse()),
    );
    expect(reordered).toBe(original);

    // 動任何一個參數都會產生不同雜湊 —— 資料庫會據此擋下偷改參數
    const tweaked = hashDefinition({
      ...factor.definition,
      winsorize: { lower_pct: 2, upper_pct: 98 },
    });
    expect(tweaked).not.toBe(original);
  });
});
