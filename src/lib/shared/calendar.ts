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

/**
 * L0 開始累積資料的第一天。
 *
 * 【這個常數與資料庫的 no_backfill check 必須一致】
 * 五張表都有 `>= date '2026-08-14'` 的約束（daily_picks／veto_events／
 * user_records／outcomes／benchmark_daily）。那條約束存在的理由是：
 * 在這天之前我們什麼都沒記錄，任何早於它的列都不可能是當時真的看到的東西。
 *
 * 【2026-08-22 實際踩到的坑】
 * 官方加權股價報酬指數（MFI94U）一次回傳近 13 個交易日，回溯到 2026-08-03。
 * 整批寫入時被 benchmark_daily_no_backfill_check 擋下，
 * 而排程對那一步設了 continue-on-error，於是**連續兩天默默沒寫入**。
 *
 * 正確作法是把來源資料裁到這一天之後，不是放寬約束 ——
 * 約束擋的正是它該擋的東西。
 */
export const L0_ACCUMULATION_START = '2026-08-14';

/** 這個日期是否落在 L0 開始累積之後（含當天） */
export function isAfterAccumulationStart(isoDate: string): boolean {
  return isoDate >= L0_ACCUMULATION_START;
}
