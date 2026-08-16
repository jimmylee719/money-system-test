/**
 * L0 原始 payload → L1 正規化列。純函式。
 *
 * 【日期一律由呼叫端傳入】
 * 用的是 L0 snapshot 的 `data_as_of`，不從每一列自己抓——
 * L0 已經依事先宣告的規則判定過日期，L1 不重複判定也不覆寫。
 *
 * 【被略過的列一定要統計】
 * 靜默丟棄資料是最難察覺的錯誤。每個 normalizer 都回報 sourceRowCount
 * 與 skipped 明細，數字對不上就會被發現。
 */

import { adCompactToIso } from '../l0/date-formats';
import {
  createParseStats,
  parseInteger,
  parseNumeric,
  parseNumericOrNote,
  parseText,
} from './parse';
import type {
  DailyQuote,
  InstitutionalRow,
  L1Market,
  MarginRow,
  MonthlyRevenueRow,
  Normalized,
  UniverseEntry,
  ValuationRow,
} from './types';

type RawRow = Record<string, unknown>;

function asRows(payload: unknown): readonly RawRow[] {
  return Array.isArray(payload) ? (payload as RawRow[]) : [];
}

/**
 * TWSE 網站端點的 `{fields, data}` 形狀轉為物件列。
 * 欄位名逐字使用官方給的 `fields`，不改名。
 */
export function rowsFromRwdTable(payload: unknown): readonly RawRow[] {
  if (typeof payload !== 'object' || payload === null) {
    return [];
  }
  const { fields, data } = payload as { fields?: unknown; data?: unknown };
  if (!Array.isArray(fields) || !Array.isArray(data)) {
    return [];
  }
  const names = fields.map((f) => String(f));
  return data
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => Object.fromEntries(names.map((name, i) => [name, row[i]])));
}

interface Skips {
  [reason: string]: number;
}

function skip(skips: Skips, reason: string): void {
  skips[reason] = (skips[reason] ?? 0) + 1;
}

// ── 標的池 ───────────────────────────────────────────────────────────────────

export function normalizeTwseCompanyProfile(payload: unknown): Normalized<UniverseEntry> {
  const raw = asRows(payload);
  const stats = createParseStats();
  const skips: Skips = {};
  const rows: UniverseEntry[] = [];

  for (const r of raw) {
    const code = parseText(r['公司代號']);
    if (code === '') {
      skip(skips, 'missing_code');
      continue;
    }
    rows.push({
      code,
      market: 'TWSE',
      name: parseText(r['公司簡稱']),
      industryCode: parseText(r['產業別']),
      listingDate: adCompactToIso(parseText(r['上市日期'])),
      paidInCapital: parseNumeric(r['實收資本額'], stats),
      issuedShares: parseNumeric(r['已發行普通股數或TDR原股發行股數'], stats),
    });
  }
  return { rows, stats, sourceRowCount: raw.length, skipped: skips };
}

export function normalizeTpexCompanyProfile(payload: unknown): Normalized<UniverseEntry> {
  const raw = asRows(payload);
  const stats = createParseStats();
  const skips: Skips = {};
  const rows: UniverseEntry[] = [];

  for (const r of raw) {
    const code = parseText(r['SecuritiesCompanyCode']);
    if (code === '') {
      skip(skips, 'missing_code');
      continue;
    }
    rows.push({
      code,
      market: 'TPEx',
      name: parseText(r['CompanyAbbreviation']),
      industryCode: parseText(r['SecuritiesIndustryCode']),
      listingDate: adCompactToIso(parseText(r['DateOfListing'])),
      // 官方欄位名帶點，逐字使用
      paidInCapital: parseNumeric(r['Paidin.Capital.NTDollars'], stats),
      issuedShares: parseNumeric(r['IssueShares'], stats),
    });
  }
  return { rows, stats, sourceRowCount: raw.length, skipped: skips };
}

// ── 行情 ─────────────────────────────────────────────────────────────────────

export function normalizeTwseQuotes(payload: unknown, date: string): Normalized<DailyQuote> {
  const raw = asRows(payload);
  const stats = createParseStats();
  const skips: Skips = {};
  const rows: DailyQuote[] = [];

  for (const r of raw) {
    const code = parseText(r['Code']);
    if (code === '') {
      skip(skips, 'missing_code');
      continue;
    }
    const change = parseNumericOrNote(r['Change'], stats);
    rows.push({
      code,
      market: 'TWSE',
      date,
      open: parseNumeric(r['OpeningPrice'], stats),
      high: parseNumeric(r['HighestPrice'], stats),
      low: parseNumeric(r['LowestPrice'], stats),
      close: parseNumeric(r['ClosingPrice'], stats),
      change: change.value,
      changeNote: change.note,
      volumeShares: parseInteger(r['TradeVolume'], stats),
      turnoverValue: parseInteger(r['TradeValue'], stats),
      transactions: parseInteger(r['Transaction'], stats),
    });
  }
  return { rows, stats, sourceRowCount: raw.length, skipped: skips };
}

export function normalizeTpexQuotes(payload: unknown, date: string): Normalized<DailyQuote> {
  const raw = asRows(payload);
  const stats = createParseStats();
  const skips: Skips = {};
  const rows: DailyQuote[] = [];

  for (const r of raw) {
    const code = parseText(r['SecuritiesCompanyCode']);
    if (code === '') {
      skip(skips, 'missing_code');
      continue;
    }
    // 除權息日官方在漲跌欄放「除權」「除息」而非數字，逐字保留
    const change = parseNumericOrNote(r['Change'], stats);
    rows.push({
      code,
      market: 'TPEx',
      date,
      // 官方以 " ---" 表示當日無成交（實測 5,202 筆），parseNumeric 會回 null
      open: parseNumeric(r['Open'], stats),
      high: parseNumeric(r['High'], stats),
      low: parseNumeric(r['Low'], stats),
      close: parseNumeric(r['Close'], stats),
      change: change.value,
      changeNote: change.note,
      volumeShares: parseInteger(r['TradingShares'], stats),
      turnoverValue: parseInteger(r['TransactionAmount'], stats),
      transactions: parseInteger(r['TransactionNumber'], stats),
    });
  }
  return { rows, stats, sourceRowCount: raw.length, skipped: skips };
}

// ── 評價 ─────────────────────────────────────────────────────────────────────

export function normalizeTwseValuation(payload: unknown, date: string): Normalized<ValuationRow> {
  const raw = asRows(payload);
  const stats = createParseStats();
  const skips: Skips = {};
  const rows: ValuationRow[] = [];

  for (const r of raw) {
    const code = parseText(r['Code']);
    if (code === '') {
      skip(skips, 'missing_code');
      continue;
    }
    rows.push({
      code,
      market: 'TWSE',
      date,
      // 虧損公司官方給空字串，解析為 null。**不得代換為 0 或極大值**
      peRatio: parseNumeric(r['PEratio'], stats),
      dividendYield: parseNumeric(r['DividendYield'], stats),
      pbRatio: parseNumeric(r['PBratio'], stats),
    });
  }
  return { rows, stats, sourceRowCount: raw.length, skipped: skips };
}

export function normalizeTpexValuation(payload: unknown, date: string): Normalized<ValuationRow> {
  const raw = asRows(payload);
  const stats = createParseStats();
  const skips: Skips = {};
  const rows: ValuationRow[] = [];

  for (const r of raw) {
    const code = parseText(r['SecuritiesCompanyCode']);
    if (code === '') {
      skip(skips, 'missing_code');
      continue;
    }
    rows.push({
      code,
      market: 'TPEx',
      date,
      peRatio: parseNumeric(r['PriceEarningRatio'], stats),
      dividendYield: parseNumeric(r['YieldRatio'], stats),
      pbRatio: parseNumeric(r['PriceBookRatio'], stats),
    });
  }
  return { rows, stats, sourceRowCount: raw.length, skipped: skips };
}

// ── 三大法人 ─────────────────────────────────────────────────────────────────

/** TWSE 為 `{fields,data}` 形狀，數字帶千分位逗號 */
export function normalizeTwseInstitutional(
  payload: unknown,
  date: string,
): Normalized<InstitutionalRow> {
  const raw = rowsFromRwdTable(payload);
  const stats = createParseStats();
  const skips: Skips = {};
  const rows: InstitutionalRow[] = [];

  for (const r of raw) {
    const code = parseText(r['證券代號']);
    if (code === '') {
      skip(skips, 'missing_code');
      continue;
    }
    rows.push({
      code,
      market: 'TWSE',
      date,
      foreignNet: parseInteger(r['外陸資買賣超股數(不含外資自營商)'], stats),
      trustNet: parseInteger(r['投信買賣超股數'], stats),
      dealerNet: parseInteger(r['自營商買賣超股數'], stats),
      totalNet: parseInteger(r['三大法人買賣超股數'], stats),
    });
  }
  return { rows, stats, sourceRowCount: raw.length, skipped: skips };
}

export function normalizeTpexInstitutional(
  payload: unknown,
  date: string,
): Normalized<InstitutionalRow> {
  const raw = asRows(payload);
  const stats = createParseStats();
  const skips: Skips = {};
  const rows: InstitutionalRow[] = [];

  for (const r of raw) {
    const code = parseText(r['SecuritiesCompanyCode']);
    if (code === '') {
      skip(skips, 'missing_code');
      continue;
    }
    rows.push({
      code,
      market: 'TPEx',
      date,
      // 官方欄位名逐字照抄（含空格與不一致的分隔）
      foreignNet: parseInteger(
        r['Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Difference'],
        stats,
      ),
      trustNet: parseInteger(r['SecuritiesInvestmentTrustCompanies-Difference'], stats),
      dealerNet: parseInteger(r['Dealers-Difference'], stats),
      totalNet: parseInteger(r['TotalDifference'], stats),
    });
  }
  return { rows, stats, sourceRowCount: raw.length, skipped: skips };
}

// ── 信用交易 ─────────────────────────────────────────────────────────────────

/**
 * ⚠️ TWSE 的 MI_MARGN payload **沒有日期欄位**，故 L0 的 data_as_of 為 null。
 * 日期由呼叫端傳入——那是 L1 明確做出的對應推論，不是 L0 的事實。
 */
export function normalizeTwseMargin(payload: unknown, date: string): Normalized<MarginRow> {
  const raw = asRows(payload);
  const stats = createParseStats();
  const skips: Skips = {};
  const rows: MarginRow[] = [];

  for (const r of raw) {
    const code = parseText(r['股票代號']);
    if (code === '') {
      skip(skips, 'missing_code');
      continue;
    }
    rows.push({
      code,
      market: 'TWSE',
      date,
      marginBalancePrevDay: parseNumeric(r['融資前日餘額'], stats),
      marginBalance: parseNumeric(r['融資今日餘額'], stats),
      shortBalancePrevDay: parseNumeric(r['融券前日餘額'], stats),
      shortBalance: parseNumeric(r['融券今日餘額'], stats),
    });
  }
  return { rows, stats, sourceRowCount: raw.length, skipped: skips };
}

export function normalizeTpexMargin(payload: unknown, date: string): Normalized<MarginRow> {
  const raw = asRows(payload);
  const stats = createParseStats();
  const skips: Skips = {};
  const rows: MarginRow[] = [];

  for (const r of raw) {
    const code = parseText(r['SecuritiesCompanyCode']);
    if (code === '') {
      skip(skips, 'missing_code');
      continue;
    }
    rows.push({
      code,
      market: 'TPEx',
      date,
      marginBalancePrevDay: parseNumeric(r['MarginPurchaseBalancePreviousDay'], stats),
      marginBalance: parseNumeric(r['MarginPurchaseBalance'], stats),
      shortBalancePrevDay: parseNumeric(r['ShortSaleBalancePreviousDay'], stats),
      shortBalance: parseNumeric(r['ShortSaleBalance'], stats),
    });
  }
  return { rows, stats, sourceRowCount: raw.length, skipped: skips };
}

// ── 月營收 ───────────────────────────────────────────────────────────────────

/**
 * 上市與上櫃的月營收欄位名相同（皆為中文），故共用。
 *
 * ⚠️ `reportDate` 是報表產生日（出表日期），`period` 是營收所屬月份（資料年月）。
 * 8/15 才公布 7 月的數字——用 period 當作可知時點就是前視偏誤。
 */
export function normalizeMonthlyRevenue(
  payload: unknown,
  market: L1Market,
  reportDate: string,
  period: string,
): Normalized<MonthlyRevenueRow> {
  const raw = asRows(payload);
  const stats = createParseStats();
  const skips: Skips = {};
  const rows: MonthlyRevenueRow[] = [];

  for (const r of raw) {
    const code = parseText(r['公司代號']);
    if (code === '') {
      skip(skips, 'missing_code');
      continue;
    }
    rows.push({
      code,
      market,
      reportDate,
      period,
      revenue: parseNumeric(r['營業收入-當月營收'], stats),
      yoyPct: parseNumeric(r['營業收入-去年同月增減(%)'], stats),
      momPct: parseNumeric(r['營業收入-上月比較增減(%)'], stats),
    });
  }
  return { rows, stats, sourceRowCount: raw.length, skipped: skips };
}
