/**
 * 日曆工具。純函式，刻意不使用 Date——避免時區與本機時鐘影響判定結果。
 */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) {
    return 0;
  }
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return DAYS_IN_MONTH[month - 1] ?? 0;
}

/** 'YYYY-MM-DD' 且必須是真實存在的日期 */
export function isValidIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value);
  if (m === null) {
    return false;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return day >= 1 && day <= daysInMonth(year, month);
}

export function assertValidIsoDate(value: string, label: string): void {
  if (!isValidIsoDate(value)) {
    throw new RangeError(`${label} must be a real 'YYYY-MM-DD' date, got "${value}"`);
  }
}
