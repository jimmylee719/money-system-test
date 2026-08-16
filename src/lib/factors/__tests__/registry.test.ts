import { describe, expect, it } from 'vitest';
import { FactorRegistry } from '../registry';
import { hashDefinition } from '../definition-hash';
import { FactorValidationError } from '../types';
import type { PostgrestClient } from '../../l0/supabase-store';
import type { FactorRegistrationInput, RegisteredFactor } from '../types';

const RATIONALE =
  '營收動能反映需求變化先於獲利數字，且月營收為法定申報資訊、公布時點固定，' +
  '不易被個別公司操縱，故以年增率排序具備可解釋的經濟機制。';

const INPUT: FactorRegistrationInput = {
  factorKey: 'rev_yoy_momentum_v1',
  displayName: '月營收年增率動能',
  definition: { source: 'mops_twse_monthly_revenue', lookbackMonths: 1 },
  economicRationale: RATIONALE,
  hypothesisDirection: 'higher_is_better',
  testPeriodStart: '2020-01-01',
  testPeriodEnd: '2025-12-31',
  tThreshold: 3.0,
  universe: 'BOTH',
  registeredBy: 'jimmy',
};

const STORED: RegisteredFactor = {
  id: 1,
  factor_key: INPUT.factorKey,
  display_name: INPUT.displayName,
  definition: INPUT.definition,
  definition_hash: hashDefinition(INPUT.definition),
  economic_rationale: RATIONALE,
  hypothesis_direction: 'higher_is_better',
  test_period_start: '2020-01-01',
  test_period_end: '2025-12-31',
  t_threshold: '3.000',
  universe: 'BOTH',
  registered_by: 'jimmy',
  registered_at: '2026-08-16T04:00:00.000Z',
};

function fakes(stored: RegisteredFactor | null = STORED): {
  registry: FactorRegistry;
  inserts: { table: string; rows: readonly unknown[] }[];
} {
  const inserts: { table: string; rows: readonly unknown[] }[] = [];
  const client: PostgrestClient = {
    async insert(table, rows) {
      inserts.push({ table, rows });
    },
    async count() {
      return 0;
    },
  };
  const reader = {
    async select<T>(): Promise<readonly T[]> {
      return (stored === null ? [] : [stored]) as unknown as readonly T[];
    },
  };
  return { registry: new FactorRegistry(client, reader), inserts };
}

describe('FactorRegistry.register', () => {
  it('計算 definition_hash，呼叫端無法自行指定', async () => {
    const f = fakes();
    const { definitionHash } = await f.registry.register(INPUT);

    expect(definitionHash).toBe(hashDefinition(INPUT.definition));
    const row = f.inserts[0]?.rows[0] as Record<string, unknown>;
    expect(row['definition_hash']).toBe(definitionHash);
  });

  it('刻意不送 registered_at —— 時間戳只能由資料庫蓋章', async () => {
    const f = fakes();
    await f.registry.register(INPUT);
    const row = f.inserts[0]?.rows[0] as Record<string, unknown>;
    expect(Object.keys(row)).not.toContain('registered_at');
    expect(Object.keys(row)).not.toContain('inserted_at');
    expect(Object.keys(row)).not.toContain('id');
  });

  it('驗證未過就不會碰資料庫', async () => {
    const f = fakes();
    await expect(f.registry.register({ ...INPUT, economicRationale: '太短' })).rejects.toThrow(
      FactorValidationError,
    );
    expect(f.inserts).toHaveLength(0);
  });
});

describe('FactorRegistry.recordTestResult', () => {
  const baseResult = {
    factorKey: INPUT.factorKey,
    definitionHash: hashDefinition(INPUT.definition),
    sampleSize: 120,
    method: 'purged_kfold_embargo',
  } as const;

  it('passed 依登記時的門檻與方向計算，不採信呼叫端', async () => {
    const f = fakes();
    const { passed } = await f.registry.recordTestResult({
      ...baseResult,
      tStatistic: 3.42,
      observedDirection: 'higher_is_better',
    });
    expect(passed).toBe(true);
    expect((f.inserts[0]?.rows[0] as Record<string, unknown>)['passed']).toBe(true);
  });

  it('方向與登記時相反即使 t 很大也不算通過', async () => {
    const f = fakes();
    const { passed } = await f.registry.recordTestResult({
      ...baseResult,
      tStatistic: 9.9,
      observedDirection: 'lower_is_better',
    });
    expect(passed).toBe(false);
  });

  it('t 未達登記門檻不算通過', async () => {
    const f = fakes();
    const { passed } = await f.registry.recordTestResult({
      ...baseResult,
      tStatistic: 2.99,
      observedDirection: 'higher_is_better',
    });
    expect(passed).toBe(false);
  });

  it('未登記的因子直接拒絕', async () => {
    const f = fakes(null);
    await expect(
      f.registry.recordTestResult({
        ...baseResult,
        tStatistic: 3.5,
        observedDirection: 'higher_is_better',
      }),
    ).rejects.toThrow(FactorValidationError);
    expect(f.inserts).toHaveLength(0);
  });

  it('樣本數不足直接拒絕，不寫入', async () => {
    const f = fakes();
    await expect(
      f.registry.recordTestResult({
        ...baseResult,
        sampleSize: 10,
        tStatistic: 3.5,
        observedDirection: 'higher_is_better',
      }),
    ).rejects.toThrow(FactorValidationError);
    expect(f.inserts).toHaveLength(0);
  });
});

describe('FactorRegistry.recordStatus', () => {
  it('理由過短即拒絕，狀態變更須可追溯', async () => {
    const f = fakes();
    await expect(f.registry.recordStatus(INPUT.factorKey, 'archived', '爛')).rejects.toThrow(
      FactorValidationError,
    );
    expect(f.inserts).toHaveLength(0);
  });

  it('理由充分則寫入事件', async () => {
    const f = fakes();
    await f.registry.recordStatus(INPUT.factorKey, 'archived', 't 值僅 1.8，未達登記門檻 3.0，封存');
    expect(f.inserts[0]?.table).toBe('factor_status_events');
  });
});
