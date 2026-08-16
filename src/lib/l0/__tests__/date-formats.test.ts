import { describe, expect, it } from 'vitest';
import {
  adCompactToIso,
  parseSourceDate,
  parseSourcePeriod,
  rocYearMonthToIsoPeriod,
} from '../date-formats';

describe('adCompactToIso', () => {
  it('converts the real TAIFEX value observed on 2026-08-16', () => {
    expect(adCompactToIso('20260814')).toBe('2026-08-14');
  });

  it('validates the calendar, not just the shape', () => {
    expect(adCompactToIso('20240229')).toBe('2024-02-29'); // 閏年
    expect(adCompactToIso('20250229')).toBe(null); // 非閏年
    expect(adCompactToIso('20261301')).toBe(null); // 13 月
    expect(adCompactToIso('20260832')).toBe(null); // 8 月 32 日
  });

  it('returns null on the wrong shape instead of guessing', () => {
    expect(adCompactToIso('1150814')).toBe(null); // 民國格式，7 碼
    expect(adCompactToIso('2026-08-14')).toBe(null);
    expect(adCompactToIso('')).toBe(null);
  });

  it('trims surrounding whitespace', () => {
    expect(adCompactToIso(' 20260814 ')).toBe('2026-08-14');
  });
});

describe('parseSourceDate — 格式必須事先宣告', () => {
  it('同一個字串在兩種格式下結果不同，所以不能靠猜', () => {
    expect(parseSourceDate('1150814', 'roc_compact')).toBe('2026-08-14');
    expect(parseSourceDate('1150814', 'ad_compact')).toBe(null); // 7 碼不是西元格式
    expect(parseSourceDate('20260814', 'ad_compact')).toBe('2026-08-14');
    expect(parseSourceDate('20260814', 'roc_compact')).toBe(null); // 8 碼不是民國格式
  });
});

describe('rocYearMonthToIsoPeriod', () => {
  it('converts the real MOPS value observed on 2026-08-16', () => {
    // 資料年月 11507 = 民國115年07月
    expect(rocYearMonthToIsoPeriod('11507')).toBe('2026-07');
  });

  it('handles 2-digit ROC years', () => {
    expect(rocYearMonthToIsoPeriod('9912')).toBe('2010-12');
    expect(rocYearMonthToIsoPeriod('10001')).toBe('2011-01');
  });

  it('rejects impossible months and malformed input', () => {
    expect(rocYearMonthToIsoPeriod('11500')).toBe(null); // 0 月
    expect(rocYearMonthToIsoPeriod('11513')).toBe(null); // 13 月
    expect(rocYearMonthToIsoPeriod('0007')).toBe(null); // 民國 0 年
    expect(rocYearMonthToIsoPeriod('1150814')).toBe(null); // 這是日期不是年月
    expect(rocYearMonthToIsoPeriod('')).toBe(null);
  });

  it('parseSourcePeriod dispatches to the declared format', () => {
    expect(parseSourcePeriod('11507', 'roc_year_month')).toBe('2026-07');
  });
});
