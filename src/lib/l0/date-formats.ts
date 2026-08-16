/**
 * 各來源的日期格式解析。純函式。
 *
 * P1 只遇到民國年壓縮格式（TWSE / TPEx 行情：`"1150814"`）。
 * P2 實測後發現 TAIFEX 用西元壓縮格式（`"20260814"`），
 * MOPS 月營收另有「資料年月」民國年月（`"11507"` = 2026-07）。
 *
 * 因此格式改為**每個來源事先宣告**，不從資料內容猜測——猜測就是判斷，違反 L0 鐵則。
 */

import { isValidIsoDate } from '../shared/calendar';
import { ROC_YEAR_OFFSET, rocDateToIso } from './roc-date';
import type { SourceDateFormat, SourcePeriodFormat } from './types';

/** "20260814" → "2026-08-14"；非真實日期回傳 null */
export function adCompactToIso(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  if (m === null) {
    return null;
  }
  const iso = `${m[1] ?? ''}-${m[2] ?? ''}-${m[3] ?? ''}`;
  return isValidIsoDate(iso) ? iso : null;
}

/** "2026-08-14" → "20260814"；非真實日期回傳 null */
export function isoDateToAdCompact(value: string): string | null {
  if (!isValidIsoDate(value)) {
    return null;
  }
  return value.replace(/-/g, '');
}

/** 依來源宣告的格式解析日期 */
export function parseSourceDate(value: string, format: SourceDateFormat): string | null {
  switch (format) {
    case 'roc_compact':
      return rocDateToIso(value);
    case 'ad_compact':
      return adCompactToIso(value);
  }
}

/** "11507" → "2026-07"（民國年月）；非法回傳 null */
export function rocYearMonthToIsoPeriod(value: string): string | null {
  const m = /^(\d{2,3})(\d{2})$/.exec(value.trim());
  if (m === null) {
    return null;
  }
  const rocYear = Number(m[1]);
  const month = Number(m[2]);
  if (rocYear <= 0 || month < 1 || month > 12) {
    return null;
  }
  return `${String(rocYear + ROC_YEAR_OFFSET).padStart(4, '0')}-${m[2] ?? ''}`;
}

/** 依來源宣告的格式解析資料期間 */
export function parseSourcePeriod(value: string, format: SourcePeriodFormat): string | null {
  switch (format) {
    case 'roc_year_month':
      return rocYearMonthToIsoPeriod(value);
  }
}
