/**
 * 已實測驗證的資料來源註冊表。
 *
 * ⚠️ 鐵則：**端點未實測回應 200 並記錄實際欄位，不得寫入本檔**。
 * `baselineFields` 一律照抄 API 實際回傳的欄位名——包含官方的錯字
 * （櫃買 `LatesAskPrice` 少一個 t），因為 L0 只存不判斷，修正錯字就是判斷。
 *
 * 實測日：2026-08-16，資料日期 1150814（民國115/08/14）。每季覆核。
 */

import type { SourceDescriptor, SourceId } from './types';

export const TWSE_STOCK_DAY_ALL: SourceDescriptor = {
  id: 'twse_stock_day_all',
  url: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '上市個股日成交資訊（全部）',
  verifiedAt: '2026-08-16',
  dateField: 'Date',
  baselineFields: [
    'Change',
    'ClosingPrice',
    'Code',
    'Date',
    'HighestPrice',
    'LowestPrice',
    'Name',
    'OpeningPrice',
    'TradeValue',
    'TradeVolume',
    'Transaction',
  ],
};

export const TWSE_BWIBBU_ALL: SourceDescriptor = {
  id: 'twse_bwibbu_all',
  url: 'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '上市個股日本益比、殖利率及股價淨值比（全部）',
  verifiedAt: '2026-08-16',
  dateField: 'Date',
  baselineFields: ['Code', 'Date', 'DividendYield', 'Name', 'PBratio', 'PEratio'],
};

export const TPEX_MAINBOARD_DAILY_CLOSE_QUOTES: SourceDescriptor = {
  id: 'tpex_mainboard_daily_close_quotes',
  url: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
  market: 'TPEx',
  sourceTier: 'official_primary',
  description: '上櫃股票每日收盤行情',
  verifiedAt: '2026-08-16',
  dateField: 'Date',
  baselineFields: [
    'Average',
    'Capitals',
    'Change',
    'Close',
    'CompanyName',
    'Date',
    'High',
    'LatesAskPrice', // 官方拼字如此（少一個 t），照抄不修正
    'LatestBidPrice',
    'Low',
    'NextLimitDown',
    'NextLimitUp',
    'NextReferencePrice',
    'Open',
    'SecuritiesCompanyCode',
    'TradingShares',
    'TransactionAmount',
    'TransactionNumber',
  ],
};

export const TPEX_MAINBOARD_PERATIO_ANALYSIS: SourceDescriptor = {
  id: 'tpex_mainboard_peratio_analysis',
  url: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis',
  market: 'TPEx',
  sourceTier: 'official_primary',
  description: '上櫃股票本益比、殖利率及股價淨值比',
  verifiedAt: '2026-08-16',
  dateField: 'Date',
  baselineFields: [
    'CompanyName',
    'Date',
    'DividendPerShare',
    'PriceBookRatio',
    'PriceEarningRatio',
    'SecuritiesCompanyCode',
    'YieldRatio',
  ],
};

export const ALL_SOURCES: readonly SourceDescriptor[] = [
  TWSE_STOCK_DAY_ALL,
  TWSE_BWIBBU_ALL,
  TPEX_MAINBOARD_DAILY_CLOSE_QUOTES,
  TPEX_MAINBOARD_PERATIO_ANALYSIS,
];

export const SOURCES_BY_ID: Readonly<Record<SourceId, SourceDescriptor>> = {
  twse_stock_day_all: TWSE_STOCK_DAY_ALL,
  twse_bwibbu_all: TWSE_BWIBBU_ALL,
  tpex_mainboard_daily_close_quotes: TPEX_MAINBOARD_DAILY_CLOSE_QUOTES,
  tpex_mainboard_peratio_analysis: TPEX_MAINBOARD_PERATIO_ANALYSIS,
};
