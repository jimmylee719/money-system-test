import { describe, expect, it } from 'vitest';
import { canonicalJson, hashDefinition } from '../definition-hash';

describe('canonicalJson', () => {
  it('sorts object keys so key order cannot change the hash', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('sorts nested objects too', () => {
    expect(canonicalJson({ z: { d: 4, c: 3 }, a: 1 })).toBe('{"a":1,"z":{"c":3,"d":4}}');
  });

  it('keeps array order — order carries meaning there', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ w: [1, 2] })).not.toBe(canonicalJson({ w: [2, 1] }));
  });

  it('drops undefined values so they cannot create phantom differences', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('handles primitives and null', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(true)).toBe('true');
  });
});

describe('hashDefinition', () => {
  const definition = { lookbackMonths: 3, source: 'mops_twse_monthly_revenue', winsorize: 0.01 };

  it('is stable regardless of key order — 同定義必同雜湊', () => {
    const reordered = { winsorize: 0.01, source: 'mops_twse_monthly_revenue', lookbackMonths: 3 };
    expect(hashDefinition(definition)).toBe(hashDefinition(reordered));
  });

  it('changes when any parameter changes — 異定義必異雜湊', () => {
    // 這正是「回測後偷偷調參」會被抓到的地方
    expect(hashDefinition({ ...definition, lookbackMonths: 6 })).not.toBe(
      hashDefinition(definition),
    );
    expect(hashDefinition({ ...definition, winsorize: 0.02 })).not.toBe(hashDefinition(definition));
  });

  it('produces a 64-char lowercase hex digest matching the SQL constraint', () => {
    expect(hashDefinition(definition)).toMatch(/^[0-9a-f]{64}$/);
  });
});
