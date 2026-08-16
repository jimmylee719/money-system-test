import { describe, expect, it } from 'vitest';
import { hashDefinition } from '../definition-hash';
import { checkDefinitionLock } from '../lock';
import type { FactorRegistrationInput, RegisteredFactor } from '../types';

const LOCAL: FactorRegistrationInput = {
  factorKey: 'demo_v1',
  displayName: '示範因子',
  definition: { spec_version: 1, value: 'a / b', winsorize: { lower_pct: 1, upper_pct: 99 } },
  economicRationale: 'x'.repeat(60),
  hypothesisDirection: 'higher_is_better',
  testPeriodStart: '2026-08-17',
  testPeriodEnd: '2027-02-17',
  tThreshold: 3.0,
  universe: 'BOTH',
  registeredBy: 'test',
};

function registered(overrides: Partial<RegisteredFactor> = {}): RegisteredFactor {
  return {
    id: 1,
    factor_key: 'demo_v1',
    display_name: '示範因子',
    definition: LOCAL.definition,
    definition_hash: hashDefinition(LOCAL.definition),
    economic_rationale: LOCAL.economicRationale,
    hypothesis_direction: 'higher_is_better',
    test_period_start: '2026-08-17',
    test_period_end: '2027-02-17',
    // PostgREST 的 numeric 是字串
    t_threshold: '3.0',
    universe: 'BOTH',
    registered_by: 'test',
    registered_at: '2026-08-16T00:00:00Z',
    ...overrides,
  };
}

describe('checkDefinitionLock', () => {
  it('完全一致時沒有問題', () => {
    expect(checkDefinitionLock([LOCAL], [registered()], new Set())).toEqual([]);
  });

  it('抓出「登記時寫 A、計算時用 B」', () => {
    // 程式端偷偷把縮尾改鬆，登記內容沒動
    const tampered: FactorRegistrationInput = {
      ...LOCAL,
      definition: { ...LOCAL.definition, winsorize: { lower_pct: 5, upper_pct: 95 } },
    };
    const issues = checkDefinitionLock([tampered], [registered()], new Set());
    expect(issues).toHaveLength(1);
    expect(issues[0]!.problem).toContain('definition_hash 不符');
  });

  it('抓出事後反轉假設方向', () => {
    const flipped: FactorRegistrationInput = { ...LOCAL, hypothesisDirection: 'lower_is_better' };
    const issues = checkDefinitionLock([flipped], [registered()], new Set());
    // 方向是 definition 之外的欄位，雜湊不會變，必須單獨比對
    expect(issues.map((i) => i.problem).join()).toContain('假設方向不符');
  });

  it('抓出事後放寬 t 門檻（字串／數字型別差異不得造成誤判）', () => {
    const loosened: FactorRegistrationInput = { ...LOCAL, tThreshold: 1.5 };
    const issues = checkDefinitionLock([loosened], [registered()], new Set());
    expect(issues.map((i) => i.problem).join()).toContain('t 門檻不符');
    // 3.0 與 '3.0' 必須視為相同，不可誤報
    expect(checkDefinitionLock([LOCAL], [registered({ t_threshold: '3.00' })], new Set())).toEqual(
      [],
    );
  });

  it('未登記的因子不得參與排序', () => {
    const issues = checkDefinitionLock([LOCAL], [], new Set());
    expect(issues[0]!.problem).toContain('尚未登記');
  });

  it('已封存的因子不得再產生訊號', () => {
    const issues = checkDefinitionLock([LOCAL], [registered()], new Set(['demo_v1']));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.problem).toContain('已封存');
  });
});
