/**
 * 民國年 ↔ 西元 轉換。純函式。
 *
 * TWSE / TPEx OpenAPI 的 `Date` 欄位為民國年字串，例如 "1150814" = 民國115年08月14日。
 * 西元年 = 民國年 + 1911。
 *
 * 無法解析時回傳 null 而非拋錯——L0 只存不判斷，抓到什麼就記什麼，
 * 由呼叫端把「無法解析」這件事本身寫進 snapshot。
 */

import { isValidIsoDate } from '../shared/calendar';

/** 民國年 6~7 碼（年 2~3 碼 + 月 2 碼 + 日 2 碼） */
const ROC_DATE_RE = /^(\d{2,3})(\d{2})(\d{2})$/;

export const ROC_YEAR_OFFSET = 1911;

/** "1150814" → "2026-08-14"；無法解析或非真實日期回傳 null */
export function rocDateToIso(value: string): string | null {
  const m = ROC_DATE_RE.exec(value.trim());
  if (m === null) {
    return null;
  }
  const rocYear = Number(m[1]);
  if (rocYear <= 0) {
    return null;
  }
  const iso = `${String(rocYear + ROC_YEAR_OFFSET).padStart(4, '0')}-${m[2] ?? ''}-${m[3] ?? ''}`;
  return isValidIsoDate(iso) ? iso : null;
}

/** "2026-08-14" → "1150814"；輸入非真實日期回傳 null */
export function isoDateToRoc(value: string): string | null {
  if (!isValidIsoDate(value)) {
    return null;
  }
  const year = Number(value.slice(0, 4)) - ROC_YEAR_OFFSET;
  if (year <= 0) {
    return null;
  }
  return `${String(year).padStart(3, '0')}${value.slice(5, 7)}${value.slice(8, 10)}`;
}
