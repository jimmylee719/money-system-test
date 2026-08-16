/**
 * L1 正規化後的型別。
 *
 * 與 L0 的差別：L0 是「官方原話」，L1 是「解讀後的事實」。
 * 每個 null 都代表「官方沒有給這個值」，**不得代換為 0**——
 * 沒有本益比與本益比為 0 是完全不同的兩件事。
 */

import type { ParseStats } from './parse';

export type L1Market = 'TWSE' | 'TPEx';

/**
 * 標的池成員。
 *
 * 【為什麼以公司基本資料為準，而不是用代號正則判斷】
 * 2026-08-16 實測：上市公司基本資料 1,095 檔中有 6 檔是 6 碼代號
 * （910322、911608…第一上市外國公司）。用「4 碼數字」正則會把它們漏掉，
 * 而且會把 ETF（0050）與權證（6 碼）誤收進來。
 * 交易所自己維護的公司名冊才是標的池的唯一依據。
 */
export interface UniverseEntry {
  readonly code: string;
  readonly market: L1Market;
  /** 公司簡稱 */
  readonly name: string;
  /** 產業別代碼（上市為數字碼如 '01'，上櫃為 SecuritiesIndustryCode） */
  readonly industryCode: string;
  /** 上市／上櫃日期（ISO），無法解析時為 null */
  readonly listingDate: string | null;
  /** 實收資本額（元） */
  readonly paidInCapital: number | null;
  /** 已發行普通股數 */
  readonly issuedShares: number | null;
}

/** 日成交行情 */
export interface DailyQuote {
  readonly code: string;
  readonly market: L1Market;
  /** 資料日期（ISO），來自 L0 的 data_as_of */
  readonly date: string;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number | null;
  /** 漲跌（元）。上櫃來源帶前導正號與尾隨空格，已正規化。 */
  readonly change: number | null;
  /**
   * 漲跌欄的官方非數值註記，逐字保留（如 `除權`、`除息`）。
   * **除權息日的漲跌不是「沒有」而是「不可直接比較」**——
   * P9 計算報酬時必須把除權息還原，丟掉這個欄位會低估報酬。
   */
  readonly changeNote: string | null;
  /** 成交股數 */
  readonly volumeShares: number | null;
  /** 成交金額（元） */
  readonly turnoverValue: number | null;
  /** 成交筆數 */
  readonly transactions: number | null;
}

/** 評價指標 */
export interface ValuationRow {
  readonly code: string;
  readonly market: L1Market;
  readonly date: string;
  /** 本益比。虧損公司官方給空字串，此處為 null。 */
  readonly peRatio: number | null;
  /** 殖利率（%） */
  readonly dividendYield: number | null;
  /** 股價淨值比 */
  readonly pbRatio: number | null;
}

/** 三大法人買賣超（股數） */
export interface InstitutionalRow {
  readonly code: string;
  readonly market: L1Market;
  readonly date: string;
  /** 外資及陸資買賣超（不含外資自營商） */
  readonly foreignNet: number | null;
  /** 投信買賣超 */
  readonly trustNet: number | null;
  /** 自營商買賣超（合計） */
  readonly dealerNet: number | null;
  /** 三大法人買賣超合計 */
  readonly totalNet: number | null;
}

/** 月營收 */
export interface MonthlyRevenueRow {
  readonly code: string;
  readonly market: L1Market;
  /** 報表產生日（ISO）＝這筆數字最早可被知道的時點 */
  readonly reportDate: string;
  /** 營收所屬月份（YYYY-MM） */
  readonly period: string;
  readonly revenue: number | null;
  /** 去年同月增減（%） */
  readonly yoyPct: number | null;
  /** 上月比較增減（%） */
  readonly momPct: number | null;
}

/** 正規化結果一律附帶解析統計，讓格式變動不會靜默通過 */
export interface Normalized<T> {
  readonly rows: readonly T[];
  readonly stats: ParseStats;
  /** 原始 payload 列數。與 rows.length 的差額即為被略過的列。 */
  readonly sourceRowCount: number;
  /** 被略過的列數與原因統計 */
  readonly skipped: Readonly<Record<string, number>>;
}
