import { describe, expect, it } from 'vitest';
import { divRound, parsePriceToCents, ratio, roundToWholeTwd, toMoney } from '../money';

describe('parsePriceToCents', () => {
  it('parses string and number prices identically', () => {
    expect(parsePriceToCents('12.35')).toBe(1235n);
    expect(parsePriceToCents(12.35)).toBe(1235n);
    expect(parsePriceToCents('12.3')).toBe(1230n);
    expect(parsePriceToCents('12')).toBe(1200n);
    expect(parsePriceToCents('0.01')).toBe(1n);
    expect(parsePriceToCents('-5.50')).toBe(-550n);
  });

  it('rejects more than 2 fraction digits instead of silently rounding', () => {
    // Math.round(1.005 * 100) === 100（不是 101），因為 1.005 的浮點表示是 1.00499...。
    // 我們選擇在邊界拋錯，不讓這種誤差進入計算。
    expect(Math.round(1.005 * 100)).toBe(100);
    expect(() => parsePriceToCents('1.005')).toThrow(RangeError);
    expect(() => parsePriceToCents(1.005)).toThrow(RangeError);
  });

  it('rejects non-finite, exponential, and malformed input', () => {
    expect(() => parsePriceToCents(Number.NaN)).toThrow(RangeError);
    expect(() => parsePriceToCents(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => parsePriceToCents(1e21)).toThrow(RangeError);
    expect(() => parsePriceToCents('abc')).toThrow(RangeError);
    expect(() => parsePriceToCents('')).toThrow(RangeError);
  });
});

describe('toMoney', () => {
  it('formats with exactly 2 fraction digits', () => {
    expect(toMoney(0n).twd).toBe('0.00');
    expect(toMoney(5n).twd).toBe('0.05');
    expect(toMoney(1235n).twd).toBe('12.35');
    expect(toMoney(100000n).twd).toBe('1000.00');
    expect(toMoney(-545100n).twd).toBe('-5451.00');
  });
});

describe('divRound', () => {
  it('floor rounds toward negative infinity', () => {
    expect(divRound(7n, 2n, 'floor')).toBe(3n);
    expect(divRound(-7n, 2n, 'floor')).toBe(-4n);
    expect(divRound(8n, 2n, 'floor')).toBe(4n);
  });

  it('ceil rounds toward positive infinity', () => {
    expect(divRound(7n, 2n, 'ceil')).toBe(4n);
    expect(divRound(-7n, 2n, 'ceil')).toBe(-3n);
    expect(divRound(8n, 2n, 'ceil')).toBe(4n);
  });

  it('half_up rounds .5 away from zero', () => {
    expect(divRound(5n, 10n, 'half_up')).toBe(1n);
    expect(divRound(-5n, 10n, 'half_up')).toBe(-1n);
    expect(divRound(4n, 10n, 'half_up')).toBe(0n);
    expect(divRound(-4n, 10n, 'half_up')).toBe(0n);
  });

  it('throws on zero denominator', () => {
    expect(() => divRound(1n, 0n, 'floor')).toThrow(RangeError);
  });
});

describe('roundToWholeTwd', () => {
  it('rounds cents to whole TWD', () => {
    expect(roundToWholeTwd(8550n, 'floor')).toBe(8500n);
    expect(roundToWholeTwd(8550n, 'ceil')).toBe(8600n);
    expect(roundToWholeTwd(8550n, 'half_up')).toBe(8600n);
    expect(roundToWholeTwd(8549n, 'half_up')).toBe(8500n);
  });
});

describe('ratio', () => {
  it('keeps 6 decimal places without float drift', () => {
    expect(ratio(949100n, 500000n)).toBe(1.8982);
    expect(ratio(-545100n, 500000n)).toBe(-1.0902);
    expect(ratio(-545100n, 545100n)).toBe(-1);
    // 949100 / 545100 = 1.7411484...  → 6 位四捨五入 = 1.741148
    expect(ratio(949100n, 545100n)).toBe(1.741148);
  });
});
