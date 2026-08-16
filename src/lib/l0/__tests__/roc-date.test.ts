import { describe, expect, it } from 'vitest';
import { isoDateToRoc, rocDateToIso } from '../roc-date';

describe('rocDateToIso', () => {
  it('converts the real API value observed on 2026-08-16', () => {
    // TWSE / TPEx 四個端點當日皆回傳 "1150814"
    expect(rocDateToIso('1150814')).toBe('2026-08-14');
  });

  it('handles 2-digit and 3-digit ROC years', () => {
    expect(rocDateToIso('0990101')).toBe('2010-01-01'); // 民國 99 年，補零 7 碼
    expect(rocDateToIso('990101')).toBe('2010-01-01'); // 民國 99 年，6 碼
    expect(rocDateToIso('1000229')).toBe(null); // 民國100年=2011，非閏年
    expect(rocDateToIso('1130229')).toBe('2024-02-29'); // 民國113年=2024，閏年
  });

  it('returns null instead of throwing on unparsable input', () => {
    expect(rocDateToIso('')).toBe(null);
    expect(rocDateToIso('2026-08-14')).toBe(null);
    expect(rocDateToIso('11508140')).toBe(null);
    expect(rocDateToIso('1151314')).toBe(null); // 13 月
    expect(rocDateToIso('1150832')).toBe(null); // 8 月 32 日
    expect(rocDateToIso('0000101')).toBe(null); // 民國 0 年
  });

  it('trims surrounding whitespace', () => {
    expect(rocDateToIso(' 1150814 ')).toBe('2026-08-14');
  });
});

describe('isoDateToRoc', () => {
  it('round-trips with rocDateToIso', () => {
    expect(isoDateToRoc('2026-08-14')).toBe('1150814');
    expect(rocDateToIso(isoDateToRoc('2024-02-29') ?? '')).toBe('2024-02-29');
  });

  it('rejects invalid or pre-ROC dates', () => {
    expect(isoDateToRoc('2026-02-30')).toBe(null);
    expect(isoDateToRoc('1911-01-01')).toBe(null);
    expect(isoDateToRoc('not-a-date')).toBe(null);
  });
});
