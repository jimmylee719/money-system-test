/**
 * L2 交易狀態公告的正規化。純函式。
 *
 * 【兩個實測慣例，處理錯了會靜默出事】
 *
 * 1️⃣ **「當日無公告」不是空陣列，是一列全空的佔位列**
 *    twse_attention 與 tpex_suspended 無資料時回傳 1 列、代號為空字串。
 *    把列數當成「有幾檔」會永遠多算一檔，而且那一檔的代號是空字串，
 *    比對時永遠不會命中，錯誤因此完全沉默。故佔位列一律過濾並計數。
 *
 * 2️⃣ **處置期間兩個交易所格式不同，且都不是標準日期**
 *    TWSE："115/08/12～115/08/18"（斜線 + 全形波浪號 U+FF5E）
 *    TPEx："1150817~1150821"（壓縮 + 半形波浪號）
 *    **處置是否現在生效取決於這個期間，不是取決於公告日**——
 *    公告日在期間之前，只看公告日會把已經結束的處置當成還在處置。
 */

import { adCompactToIso } from '../l0/date-formats';
import { rocDateToIso } from '../l0/roc-date';
import { isValidIsoDate } from '../shared/calendar';
import type { L1Market } from '../l1/types';
import type {
  AlteredTradingRow,
  AttentionRow,
  DispositionRow,
  SuspensionRow,
} from './types';

type RawRow = Record<string, unknown>;

function asRows(payload: unknown): readonly RawRow[] {
  return Array.isArray(payload) ? (payload as RawRow[]) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value);
}

/** 官方旗標是**全形** Ｙ（U+FF39），不是 ASCII 的 Y。兩者都接受，其餘一律為否。 */
function isFlagSet(value: unknown): boolean {
  const t = text(value);
  return t === 'Ｙ' || t === 'Y';
}

export interface NormalizedStatus<T> {
  readonly rows: readonly T[];
  /** 原始列數 */
  readonly sourceRowCount: number;
  /** 被過濾掉的佔位列數（代號為空）。這是正常狀態，代表當日無此類公告。 */
  readonly placeholderRows: number;
}

function result<T>(rows: readonly T[], sourceRowCount: number, placeholderRows: number) {
  return { rows, sourceRowCount, placeholderRows };
}

// ── 處置期間 ─────────────────────────────────────────────────────────────────

export interface DispositionPeriod {
  readonly start: string | null;
  readonly end: string | null;
}

/** "115/08/12" → "2026-08-12"；非法回傳 null */
function rocSlashedToIso(value: string): string | null {
  const m = /^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/.exec(value.trim());
  if (m === null) {
    return null;
  }
  const year = Number(m[1]) + 1911;
  const iso = `${String(year).padStart(4, '0')}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  return isValidIsoDate(iso) ? iso : null;
}

/**
 * 解析處置期間。同時支援兩個交易所各自的格式，任一端解析失敗即回 null。
 *
 * 分隔符實測有全形「～」(U+FF5E) 與半形「~」兩種，一併接受。
 */
export function parseDispositionPeriod(raw: string): DispositionPeriod {
  const parts = raw.split(/[～~]/);
  if (parts.length !== 2) {
    return { start: null, end: null };
  }
  const parse = (s: string): string | null => {
    const t = s.trim();
    return t.includes('/') ? rocSlashedToIso(t) : rocDateToIso(t);
  };
  return { start: parse(parts[0]!), end: parse(parts[1]!) };
}

// ── 注意股 ───────────────────────────────────────────────────────────────────

export function normalizeTwseAttention(payload: unknown): NormalizedStatus<AttentionRow> {
  const raw = asRows(payload);
  const rows: AttentionRow[] = [];
  let placeholders = 0;

  for (const r of raw) {
    const code = text(r['Code']);
    if (code === '') {
      placeholders += 1; // 當日無注意股的佔位列
      continue;
    }
    rows.push({
      code,
      market: 'TWSE',
      date: rocDateToIso(text(r['Date'])),
      info: text(r['TradingInfoForAttention']),
    });
  }
  return result(rows, raw.length, placeholders);
}

export function normalizeTpexAttention(payload: unknown): NormalizedStatus<AttentionRow> {
  const raw = asRows(payload);
  const rows: AttentionRow[] = [];
  let placeholders = 0;

  for (const r of raw) {
    const code = text(r['SecuritiesCompanyCode']);
    if (code === '') {
      placeholders += 1;
      continue;
    }
    rows.push({
      code,
      market: 'TPEx',
      date: rocDateToIso(text(r['Date'])),
      info: text(r['TradingInformation']),
    });
  }
  return result(rows, raw.length, placeholders);
}

// ── 處置股 ───────────────────────────────────────────────────────────────────

export function normalizeTwseDisposition(payload: unknown): NormalizedStatus<DispositionRow> {
  const raw = asRows(payload);
  const rows: DispositionRow[] = [];
  let placeholders = 0;

  for (const r of raw) {
    const code = text(r['Code']);
    if (code === '') {
      placeholders += 1;
      continue;
    }
    const periodRaw = text(r['DispositionPeriod']);
    const period = parseDispositionPeriod(periodRaw);
    rows.push({
      code,
      market: 'TWSE',
      announcedDate: rocDateToIso(text(r['Date'])),
      periodStart: period.start,
      periodEnd: period.end,
      periodRaw,
      reason: text(r['ReasonsOfDisposition']),
      measure: text(r['DispositionMeasures']),
    });
  }
  return result(rows, raw.length, placeholders);
}

export function normalizeTpexDisposition(payload: unknown): NormalizedStatus<DispositionRow> {
  const raw = asRows(payload);
  const rows: DispositionRow[] = [];
  let placeholders = 0;

  for (const r of raw) {
    const code = text(r['SecuritiesCompanyCode']);
    if (code === '') {
      placeholders += 1;
      continue;
    }
    const periodRaw = text(r['DispositionPeriod']);
    const period = parseDispositionPeriod(periodRaw);
    rows.push({
      code,
      market: 'TPEx',
      announcedDate: rocDateToIso(text(r['Date'])),
      periodStart: period.start,
      periodEnd: period.end,
      periodRaw,
      reason: text(r['DispositionReasons']),
      // 上櫃把措施寫在 DisposalCondition 的長文裡，無獨立欄位
      measure: '',
    });
  }
  return result(rows, raw.length, placeholders);
}

// ── 暫停交易 ─────────────────────────────────────────────────────────────────

export function normalizeTwseSuspension(payload: unknown): NormalizedStatus<SuspensionRow> {
  const raw = asRows(payload);
  const rows: SuspensionRow[] = [];
  let placeholders = 0;

  for (const r of raw) {
    const code = text(r['Code']);
    if (code === '') {
      placeholders += 1;
      continue;
    }
    const halt = text(r['TradingHaltDate']);
    const resume = text(r['TradingResumptionDate']);
    rows.push({
      code,
      market: 'TWSE',
      haltDate: rocDateToIso(halt),
      resumptionDate: rocDateToIso(resume),
      raw: `暫停 ${halt} ${text(r['TradingHaltTime'])}／恢復 ${resume} ${text(r['TradingResumptionTime'])}`,
    });
  }
  return result(rows, raw.length, placeholders);
}

/**
 * ⚠️ 上櫃的欄位名是中文的「暫停交易」「恢復交易」，且 Date 是**西元**壓縮。
 * 這兩點都與同批其他上櫃端點不同，實測確認過。
 */
export function normalizeTpexSuspension(payload: unknown): NormalizedStatus<SuspensionRow> {
  const raw = asRows(payload);
  const rows: SuspensionRow[] = [];
  let placeholders = 0;

  for (const r of raw) {
    const code = text(r['SecuritiesCompanyCode']);
    if (code === '') {
      placeholders += 1;
      continue;
    }
    const halt = text(r['暫停交易']);
    const resume = text(r['恢復交易']);
    rows.push({
      code,
      market: 'TPEx',
      // 公告本身的日期是西元；停復牌欄位的格式官方未於實測日提供樣本，
      // 故兩種格式都試，皆失敗則為 null（不猜）
      haltDate: adCompactToIso(halt) ?? rocDateToIso(halt),
      resumptionDate: adCompactToIso(resume) ?? rocDateToIso(resume),
      raw: `公告日 ${text(r['Date'])}／暫停 ${halt}／恢復 ${resume}`,
    });
  }
  return result(rows, raw.length, placeholders);
}

// ── 變更交易方法 ─────────────────────────────────────────────────────────────

/**
 * TWSE 的 TWT85U 只有 Code / Name / PeriodicCallAuctionTrading 三欄，
 * **沒有旗標可判斷類別**——列出現在這張表裡就代表該證券變更交易方法。
 * PeriodicCallAuctionTrading 實測值為 "  "（兩個空格）或 "**"，逐字保留不解讀。
 */
export function normalizeTwseAlteredTrading(payload: unknown): NormalizedStatus<AlteredTradingRow> {
  const raw = asRows(payload);
  const rows: AlteredTradingRow[] = [];
  let placeholders = 0;

  for (const r of raw) {
    const code = text(r['Code']);
    if (code === '') {
      placeholders += 1;
      continue;
    }
    const flag = typeof r['PeriodicCallAuctionTrading'] === 'string'
      ? (r['PeriodicCallAuctionTrading'] as string)
      : '';
    rows.push({
      code,
      market: 'TWSE',
      date: null, // 此 payload 無日期欄位（實測）
      alteredTrading: true, // 列的存在本身即為事實
      periodicTrading: flag.trim() !== '',
      managedStock: false, // TWSE 此端點不提供此區分
      suspensionOfTrading: false,
      raw: `變更交易（PeriodicCallAuctionTrading=${JSON.stringify(flag)}）`,
    });
  }
  return result(rows, raw.length, placeholders);
}

export function normalizeTpexAlteredTrading(payload: unknown): NormalizedStatus<AlteredTradingRow> {
  const raw = asRows(payload);
  const rows: AlteredTradingRow[] = [];
  let placeholders = 0;

  for (const r of raw) {
    const code = text(r['SecuritiesCompanyCode']);
    if (code === '') {
      placeholders += 1;
      continue;
    }
    const altered = isFlagSet(r['AlteredTrading']);
    const periodic = isFlagSet(r['PeriodicTrading']);
    const managed = isFlagSet(r['ManagedStock']);
    const suspension = isFlagSet(r['SuspensionOfTrading']);
    rows.push({
      code,
      market: 'TPEx',
      date: rocDateToIso(text(r['Date'])),
      alteredTrading: altered,
      periodicTrading: periodic,
      managedStock: managed,
      suspensionOfTrading: suspension,
      raw:
        `變更交易=${text(r['AlteredTrading'])}／分盤=${text(r['PeriodicTrading'])}` +
        `／管理股票=${text(r['ManagedStock'])}／停止交易=${text(r['SuspensionOfTrading'])}` +
        `／撮合間隔=${text(r['MatchingFrequency'])}`,
    });
  }
  return result(rows, raw.length, placeholders);
}
