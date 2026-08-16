import { describe, expect, it } from 'vitest';
import {
  MIN_RATIONALE_LENGTH,
  MIN_SAMPLE_SIZE,
  MIN_T_THRESHOLD,
  computePassed,
  validateRegistration,
  validateTestResult,
} from '../validation';
import type { FactorRegistrationInput, FactorTestResultInput } from '../types';

const GOOD_RATIONALE =
  '營收動能反映需求變化先於獲利數字，且月營收為法定申報資訊、公布時點固定，' +
  '不易被個別公司操縱，故以年增率排序具備可解釋的經濟機制。';

const VALID: FactorRegistrationInput = {
  factorKey: 'rev_yoy_momentum_v1',
  displayName: '月營收年增率動能',
  definition: { source: 'mops_twse_monthly_revenue', field: '營業收入-去年同月增減(%)' },
  economicRationale: GOOD_RATIONALE,
  hypothesisDirection: 'higher_is_better',
  testPeriodStart: '2020-01-01',
  testPeriodEnd: '2025-12-31',
  tThreshold: 3.0,
  universe: 'BOTH',
  registeredBy: 'jimmy',
};

describe('validateRegistration', () => {
  it('accepts a complete, well-formed registration', () => {
    expect(validateRegistration(VALID)).toEqual([]);
  });

  it('rejects a blank or perfunctory economic rationale', () => {
    // CLAUDE.md：economic_rationale 空白即拒絕
    for (const rationale of ['', '   ', '因為會漲']) {
      const issues = validateRegistration({ ...VALID, economicRationale: rationale });
      expect(issues.map((i) => i.field)).toContain('economicRationale');
    }
    expect(GOOD_RATIONALE.length).toBeGreaterThanOrEqual(MIN_RATIONALE_LENGTH);
  });

  it('rejects a t threshold below 3.0 — 不得事後放寬', () => {
    expect(validateRegistration({ ...VALID, tThreshold: 2.9 }).map((i) => i.field)).toContain(
      'tThreshold',
    );
    expect(validateRegistration({ ...VALID, tThreshold: MIN_T_THRESHOLD })).toEqual([]);
  });

  it('rejects a malformed factor key', () => {
    for (const key of ['A_bad', 'ab', '1abc', 'has-dash', 'has space']) {
      expect(validateRegistration({ ...VALID, factorKey: key }).map((i) => i.field)).toContain(
        'factorKey',
      );
    }
  });

  it('rejects an impossible or inverted test period', () => {
    expect(
      validateRegistration({ ...VALID, testPeriodStart: '2025-02-30' }).map((i) => i.field),
    ).toContain('testPeriodStart');
    expect(
      validateRegistration({ ...VALID, testPeriodStart: '2025-12-31', testPeriodEnd: '2020-01-01' })
        .map((i) => i.field),
    ).toContain('testPeriodEnd');
  });

  it('rejects an empty definition', () => {
    expect(validateRegistration({ ...VALID, definition: {} }).map((i) => i.field)).toContain(
      'definition',
    );
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const issues = validateRegistration({
      ...VALID,
      factorKey: 'X',
      economicRationale: '',
      tThreshold: 1,
      registeredBy: '',
    });
    expect(issues.map((i) => i.field).sort()).toEqual(
      ['economicRationale', 'factorKey', 'registeredBy', 'tThreshold'].sort(),
    );
  });
});

const VALID_RESULT: FactorTestResultInput = {
  factorKey: 'rev_yoy_momentum_v1',
  definitionHash: 'a'.repeat(64),
  tStatistic: 3.42,
  sampleSize: 120,
  observedDirection: 'higher_is_better',
  method: 'purged_kfold_embargo',
};

describe('validateTestResult', () => {
  it('accepts a well-formed result', () => {
    expect(validateTestResult(VALID_RESULT)).toEqual([]);
  });

  it('rejects a sample smaller than 30 — CLAUDE.md 不得下結論', () => {
    expect(validateTestResult({ ...VALID_RESULT, sampleSize: 29 }).map((i) => i.field)).toContain(
      'sampleSize',
    );
    expect(validateTestResult({ ...VALID_RESULT, sampleSize: MIN_SAMPLE_SIZE })).toEqual([]);
  });

  it('rejects standard k-fold — 金融資料必然洩漏', () => {
    const issues = validateTestResult({
      ...VALID_RESULT,
      method: 'kfold' as FactorTestResultInput['method'],
    });
    expect(issues.map((i) => i.field)).toContain('method');
    expect(issues[0]?.message).toContain('k-fold');
  });

  it('rejects a malformed definition hash', () => {
    expect(
      validateTestResult({ ...VALID_RESULT, definitionHash: 'abc' }).map((i) => i.field),
    ).toContain('definitionHash');
  });
});

describe('computePassed — 與 SQL 觸發器同一套邏輯', () => {
  it('requires BOTH the t threshold and the declared direction', () => {
    expect(computePassed(3.5, 'higher_is_better', 3.0, 'higher_is_better')).toBe(true);
    // t 夠大但方向與登記時相反 → 不算通過，不能事後翻轉假設
    expect(computePassed(3.5, 'lower_is_better', 3.0, 'higher_is_better')).toBe(false);
    // 方向對但 t 不足
    expect(computePassed(2.9, 'higher_is_better', 3.0, 'higher_is_better')).toBe(false);
  });

  it('treats exactly-at-threshold as a pass', () => {
    expect(computePassed(3.0, 'higher_is_better', 3.0, 'higher_is_better')).toBe(true);
  });
});
