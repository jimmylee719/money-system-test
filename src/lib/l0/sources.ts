/**
 * 已實測驗證的資料來源註冊表。
 *
 * ⚠️ 鐵則：**端點未實測回應 200 並記錄實際欄位，不得寫入本檔**。
 * `baselineFields` 一律照抄 API 實際回傳的欄位名與順序——包含官方的怪癖：
 *   - 櫃買行情 `LatesAskPrice`（少一個 t）
 *   - TWSE 重大訊息 `"主旨 "`（結尾帶一個空格）
 *   - 櫃買基本資料 `UnifiedBusinessNo.`、`Paidin.Capital.NTDollars`（帶點）
 * L0 只存不判斷，修正錯字就是判斷。
 *
 * 端點目錄來源（實測 2026-08-16）：
 *   TWSE   https://openapi.twse.com.tw/v1/swagger.json      （143 個端點）
 *   TPEx   https://www.tpex.org.tw/openapi/swagger.json     （225 個端點）
 *   TAIFEX https://openapi.taifex.com.tw/swagger.json       （135 個端點）
 *
 * 每季覆核。
 */

import type { SourceDescriptor, SourceId } from './types';

// ── P1：TWSE / TPEx 行情 ─────────────────────────────────────────────────────

export const TWSE_STOCK_DAY_ALL: SourceDescriptor = {
  id: 'twse_stock_day_all',
  url: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '上市個股日成交資訊（全部）',
  usedBy: 'P5 訊號引擎（價量因子）／P9 outcomes 報酬計算',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Date',
    'Code',
    'Name',
    'TradeVolume',
    'TradeValue',
    'OpeningPrice',
    'HighestPrice',
    'LowestPrice',
    'ClosingPrice',
    'Change',
    'Transaction',
  ],
};

export const TWSE_BWIBBU_ALL: SourceDescriptor = {
  id: 'twse_bwibbu_all',
  url: 'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '上市個股日本益比、殖利率及股價淨值比（全部）',
  usedBy: 'P5 訊號引擎（評價因子）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: ['Date', 'Code', 'Name', 'PEratio', 'DividendYield', 'PBratio'],
};

export const TPEX_MAINBOARD_DAILY_CLOSE_QUOTES: SourceDescriptor = {
  id: 'tpex_mainboard_daily_close_quotes',
  url: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
  market: 'TPEx',
  sourceTier: 'official_primary',
  description: '上櫃股票每日收盤行情',
  usedBy: 'P5 訊號引擎（價量因子）／P9 outcomes 報酬計算',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Date',
    'SecuritiesCompanyCode',
    'CompanyName',
    'Close',
    'Change',
    'Open',
    'High',
    'Low',
    'Average',
    'TradingShares',
    'TransactionAmount',
    'TransactionNumber',
    'LatestBidPrice',
    'LatesAskPrice', // 官方拼字如此（少一個 t），照抄不修正
    'Capitals',
    'NextReferencePrice',
    'NextLimitUp',
    'NextLimitDown',
  ],
};

export const TPEX_MAINBOARD_PERATIO_ANALYSIS: SourceDescriptor = {
  id: 'tpex_mainboard_peratio_analysis',
  url: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis',
  market: 'TPEx',
  sourceTier: 'official_primary',
  description: '上櫃股票本益比、殖利率及股價淨值比',
  usedBy: 'P5 訊號引擎（評價因子）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Date',
    'SecuritiesCompanyCode',
    'CompanyName',
    'PriceEarningRatio',
    'DividendPerShare',
    'YieldRatio',
    'PriceBookRatio',
  ],
};

// ── P2：MOPS（公開資訊觀測站，經交易所 OpenAPI 轉發） ────────────────────────

/**
 * 月營收有**兩個日期**，語意完全不同，必須分開存：
 *   出表日期 1150815 = 報表產生日 → data_as_of  = 2026-08-15
 *   資料年月 11507   = 營收所屬月 → data_period = 2026-07
 * 混為一談會造成前視偏誤（用 8/15 才公布的資料去解釋 7 月的股價）。
 */
export const MOPS_TWSE_MONTHLY_REVENUE: SourceDescriptor = {
  id: 'mops_twse_monthly_revenue',
  url: 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '上市公司每月營業收入彙總表',
  usedBy: 'P5 訊號引擎（營收動能因子）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: '出表日期',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: '資料年月',
  periodFormat: 'roc_year_month',
  baselineFields: [
    '出表日期',
    '資料年月',
    '公司代號',
    '公司名稱',
    '產業別',
    '營業收入-當月營收',
    '營業收入-上月營收',
    '營業收入-去年當月營收',
    '營業收入-上月比較增減(%)',
    '營業收入-去年同月增減(%)',
    '累計營業收入-當月累計營收',
    '累計營業收入-去年累計營收',
    '累計營業收入-前期比較增減(%)',
    '備註',
  ],
};

export const MOPS_TPEX_MONTHLY_REVENUE: SourceDescriptor = {
  id: 'mops_tpex_monthly_revenue',
  url: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O',
  market: 'TPEx',
  sourceTier: 'official_primary',
  description: '上櫃公司每月營業收入彙總表',
  usedBy: 'P5 訊號引擎（營收動能因子）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: '出表日期',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: '資料年月',
  periodFormat: 'roc_year_month',
  baselineFields: [
    '出表日期',
    '資料年月',
    '公司代號',
    '公司名稱',
    '產業別',
    '營業收入-當月營收',
    '營業收入-上月營收',
    '營業收入-去年當月營收',
    '營業收入-上月比較增減(%)',
    '營業收入-去年同月增減(%)',
    '累計營業收入-當月累計營收',
    '累計營業收入-去年累計營收',
    '累計營業收入-前期比較增減(%)',
    '備註',
  ],
};

export const MOPS_TWSE_COMPANY_PROFILE: SourceDescriptor = {
  id: 'mops_twse_company_profile',
  url: 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '上市公司基本資料（產業別、實收資本額、已發行股數等）',
  usedBy: 'P5 排序分群（同業比較）／P6 L2 否決層（規模門檻）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: '出表日期',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    '出表日期',
    '公司代號',
    '公司名稱',
    '公司簡稱',
    '外國企業註冊地國',
    '產業別',
    '住址',
    '營利事業統一編號',
    '董事長',
    '總經理',
    '發言人',
    '發言人職稱',
    '代理發言人',
    '總機電話',
    '成立日期',
    '上市日期',
    '普通股每股面額',
    '實收資本額',
    '私募股數',
    '特別股',
    '編制財務報表類型',
    '股票過戶機構',
    '過戶電話',
    '過戶地址',
    '簽證會計師事務所',
    '簽證會計師1',
    '簽證會計師2',
    '英文簡稱',
    '英文通訊地址',
    '傳真機號碼',
    '電子郵件信箱',
    '網址',
    '已發行普通股數或TDR原股發行股數',
  ],
};

export const MOPS_TPEX_COMPANY_PROFILE: SourceDescriptor = {
  id: 'mops_tpex_company_profile',
  url: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O',
  market: 'TPEx',
  sourceTier: 'official_primary',
  description: '上櫃股票基本資料（產業別、實收資本額、已發行股數等）',
  usedBy: 'P5 排序分群（同業比較）／P6 L2 否決層（規模門檻）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Date',
    'SecuritiesCompanyCode',
    'CompanyName',
    'CompanyAbbreviation',
    'Registration',
    'SecuritiesIndustryCode',
    'Address',
    'UnifiedBusinessNo.', // 官方欄位名結尾帶點，照抄
    'Chairman',
    'GeneralManager',
    'Spokesman',
    'TitleOfSpokesman',
    'DeputySpokesperson',
    'Telephone',
    'DateOfIncorporation',
    'DateOfListing',
    'ParValueOfCommonStock',
    'Paidin.Capital.NTDollars',
    'PrivateStock.shares',
    'PreferredStock.shares',
    'PreparationOfFinancialReportType',
    'StockTransferAgent',
    'StockTransferAgentTelephone',
    'StockTransferAgentAddress',
    'AccountingFirm',
    'CPA.CharteredPublicAccountant.First',
    'CPA.CharteredPublicAccountant.Second',
    'Symbol',
    'Fax',
    'EmailAddress',
    'WebAddress',
    'IssueShares',
  ],
};

/**
 * 重大訊息同樣有兩個日期：出表日期（報表產生日）與發言日期（公司實際發言日）。
 * data_as_of 取**發言日期**，因為那才是事件發生的時點；
 * 一份報表可能含多個發言日，故 dateSelection 用 'max'。
 */
export const MOPS_TWSE_MATERIAL_ANNOUNCEMENTS: SourceDescriptor = {
  id: 'mops_twse_material_announcements',
  url: 'https://openapi.twse.com.tw/v1/opendata/t187ap04_L',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '上市公司每日重大訊息',
  usedBy: 'P6 L2 否決層（事件過濾）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: '發言日期',
  dateFormat: 'roc_compact',
  dateSelection: 'max',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    '出表日期',
    '發言日期',
    '發言時間',
    '公司代號',
    '公司名稱',
    '主旨 ', // 官方欄位名結尾帶一個空格，照抄
    '符合條款',
    '事實發生日',
    '說明',
  ],
};

export const MOPS_TPEX_MATERIAL_ANNOUNCEMENTS: SourceDescriptor = {
  id: 'mops_tpex_material_announcements',
  url: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O',
  market: 'TPEx',
  sourceTier: 'official_primary',
  description: '上櫃公司每日重大訊息',
  usedBy: 'P6 L2 否決層（事件過濾）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: '發言日期',
  dateFormat: 'roc_compact',
  dateSelection: 'max',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Date',
    '發言日期',
    '發言時間',
    'SecuritiesCompanyCode',
    'CompanyName',
    '主旨', // 櫃買這裡沒有結尾空格，與 TWSE 不同
    '符合條款',
    '事實發生日',
    '說明',
  ],
};

// ── P2：TAIFEX ───────────────────────────────────────────────────────────────
// 注意：TAIFEX 回傳的 Content-Type 是 application/octet-stream，內容仍是 JSON。
// 本模組以內容判斷而非以標頭判斷，故不受影響。

export const TAIFEX_INSTITUTIONAL_FUTURES_OPTIONS: SourceDescriptor = {
  id: 'taifex_institutional_futures_options',
  url: 'https://openapi.taifex.com.tw/v1/MarketDataOfMajorInstitutionalTradersDividedByFuturesAndOptionsBytheDate',
  market: 'TAIFEX',
  sourceTier: 'official_primary',
  description: '三大法人-區分期貨與選擇權二類-依日期',
  usedBy: 'P6 L2 否決層（市場環境）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  dateFormat: 'ad_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Date',
    'Item',
    'FuturesTradingVolume(Long)',
    'OptionsTradingVolume(Long)',
    'FuturesTradingValue(Long)(Thousands)',
    'OptionsTradingValue(Long)(Thousands)',
    'FuturesTradingVolume(Short)',
    'OptionsTradingVolume(Short)',
    'FuturesTradingValue(Short)(Thousands)',
    'OptionsTradingValue(Short)(Thousands)',
    'FuturesTradingVolume(Net)',
    'OptionsTradingVolume(Net)',
    'FuturesTradingValue(Net)(Thousands)',
    'OptionsTradingValue(Net)(Thousands)',
    'FuturesOpenInterest(Long)',
    'OptionsOpenInterest(Long)',
    'FuturesContractValueofOpenInterest(Long)(Thousands)',
    'OptionsContractValueofOpenInterest(Long)(Thousands)',
    'FuturesOpenInterest(Short)',
    'OptionsOpenInterest(Short)',
    'FuturesContractValueofOpenInterest(Short)(Thousands)',
    'OptionsContractValueofOpenInterest(Short)(Thousands)',
    'FuturesOpenInterest(Net)',
    'OptionsOpenInterest(Net)',
    'FuturesContractValueofOpenInterest(Net)(Thousands)',
    'OptionsContractValueofOpenInterest(Net)(Thousands)',
  ],
};

/** 一次回傳近 23 個交易日的滾動視窗，故 dateSelection 用 'max' */
export const TAIFEX_PUT_CALL_RATIO: SourceDescriptor = {
  id: 'taifex_put_call_ratio',
  url: 'https://openapi.taifex.com.tw/v1/PutCallRatio',
  market: 'TAIFEX',
  sourceTier: 'official_primary',
  description: '臺指選擇權 Put/Call 比',
  usedBy: 'P6 L2 否決層（市場情緒）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  dateFormat: 'ad_compact',
  dateSelection: 'max',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Date',
    'PutVolume',
    'CallVolume',
    'PutCallVolumeRatio%',
    'PutOI',
    'CallOI',
    'PutCallOIRatio%',
  ],
};

export const TAIFEX_LARGE_TRADERS_FUTURES: SourceDescriptor = {
  id: 'taifex_large_traders_futures',
  url: 'https://openapi.taifex.com.tw/v1/OpenInterestOfLargeTradersFutures',
  market: 'TAIFEX',
  sourceTier: 'official_primary',
  description: '期貨大額交易人未沖銷部位資料',
  usedBy: 'P6 L2 否決層（市場環境）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  dateFormat: 'ad_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Date',
    'Contract',
    'ContractName',
    'SettlementMonth',
    'TypeOfTraders',
    'Top5Buy',
    'Top5Sell',
    'Top10Buy',
    'Top10Sell',
    'OIOfMarket',
  ],
};

// ── P2.5：個股三大法人買賣超與信用交易 ───────────────────────────────────────

/**
 * ⚠️ 唯一一個**不在** OpenAPI 目錄裡的來源。
 *
 * 2026-08-16 實測：TWSE OpenAPI 143 個端點以「法人／投信／外資／自營／T86」
 * 關鍵字全掃，只有外資持股比率（MI_QFIIS_*），**查無個股三大法人買賣超**。
 * 但個股法人買賣超是台股最常用的因子輸入之一，缺了 P5 會做不完整。
 *
 * 因此改用 TWSE 網站自己在用的端點：資料同樣是官方一手，但未列入 OpenAPI 目錄，
 * 可能無預警變動 → `endpointStability: 'website_internal'`，drift 監控要特別留意。
 *
 * 兩個與其他來源不同之處：
 *   1. payload 形狀是 `{stat, date, fields, data}`，欄位名與資料分離，
 *      數字帶千分位逗號（如 "83,309,387"）—— L0 只存不判斷，逗號照留
 *   2. 必須帶日期參數。日期取自 twse_stock_day_all 的 data_as_of，
 *      也就是**交易所自己宣告的最新交易日**，不用系統時鐘猜（會撞到假日）
 */
export const TWSE_INSTITUTIONAL_BY_STOCK: SourceDescriptor = {
  id: 'twse_institutional_by_stock',
  url: 'https://www.twse.com.tw/rwd/zh/fund/T86?date={date_ad_compact}&selectType=ALL&response=json',
  dateFrom: 'twse_stock_day_all',
  endpointStability: 'website_internal',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '上市個股三大法人買賣超日報',
  usedBy: 'P5 訊號引擎（法人籌碼因子）／P6 L2 否決層',
  verifiedAt: '2026-08-16',
  payloadShape: 'twse_rwd_table',
  dateField: 'date', // 頂層鍵，非每列欄位
  dateFormat: 'ad_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    '證券代號',
    '證券名稱',
    '外陸資買進股數(不含外資自營商)',
    '外陸資賣出股數(不含外資自營商)',
    '外陸資買賣超股數(不含外資自營商)',
    '外資自營商買進股數',
    '外資自營商賣出股數',
    '外資自營商買賣超股數',
    '投信買進股數',
    '投信賣出股數',
    '投信買賣超股數',
    '自營商買賣超股數',
    '自營商買進股數(自行買賣)',
    '自營商賣出股數(自行買賣)',
    '自營商買賣超股數(自行買賣)',
    '自營商買進股數(避險)',
    '自營商賣出股數(避險)',
    '自營商買賣超股數(避險)',
    '三大法人買賣超股數',
  ],
};

/**
 * 2026-08-16 實測澄清：此端點是**個股層級**（1,294 列，含股票代號），
 * 先前 P2 報告標為「未驗證粒度」，現已確認。
 *
 * ⚠️ **此端點的 payload 完全沒有日期欄位**（16 個欄位皆為個股資料）。
 * 因此 `dateField` 留空，data_as_of 會如實記為 null、原因 `date_field_missing`，
 * 原始 bytes 歸入 unknown-date。
 *
 * 刻意不從同一次抓取的其他來源「借」日期填進去 —— 那是推論不是事實，
 * 而 data_as_of 的語意就是「payload 自己宣告的日期」。
 * L1 要使用時以 fetched_at 搭配交易日曆對應，屆時該推論會被明確記錄在 L1，
 * 不會混進 L0 假裝成事實。
 */
export const TWSE_MARGIN_BALANCE: SourceDescriptor = {
  id: 'twse_margin_balance',
  url: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '上市個股融資融券餘額',
  usedBy: 'P5 訊號引擎（信用交易因子）／P6 L2 否決層（籌碼面）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  /** 空字串＝此 payload 沒有日期欄位（見上方說明），不是漏填 */
  dateField: '',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    '股票代號',
    '股票名稱',
    '融資買進',
    '融資賣出',
    '融資現金償還',
    '融資前日餘額',
    '融資今日餘額',
    '融資限額',
    '融券買進',
    '融券賣出',
    '融券現券償還',
    '融券前日餘額',
    '融券今日餘額',
    '融券限額',
    '資券互抵',
    '註記',
  ],
};

/** 櫃買的個股三大法人在正式 OpenAPI 目錄裡，不需走網站端點 */
export const TPEX_INSTITUTIONAL_BY_STOCK: SourceDescriptor = {
  id: 'tpex_institutional_by_stock',
  url: 'https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  market: 'TPEx',
  sourceTier: 'official_primary',
  description: '上櫃股票三大法人買賣明細資訊',
  usedBy: 'P5 訊號引擎（法人籌碼因子）／P6 L2 否決層',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  // 官方欄位名含前導空格與不一致的分隔，逐字照抄：
  //   " Foreign Investors ...-Total Sell" 開頭有空格
  //   "Dealers -TotalSell" 與 "Dealers-TotalSell" 並存
  baselineFields: [
    'Date',
    'SecuritiesCompanyCode',
    'CompanyName',
    'Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Total Buy',
    ' Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Total Sell',
    'Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Difference',
    'Foreign Dealers-Total Buy',
    'Foreign Dealers-TotalSell',
    'ForeignDealers-Difference',
    'ForeignInvestorsIncludeMainlandAreaInvestors-TotalBuy',
    'ForeignInvestorsIncludeMainlandAreaInvestors-TotalSell',
    'ForeignInvestorsInclude MainlandAreaInvestors-Difference',
    'SecuritiesInvestmentTrustCompanies-TotalBuy',
    'SecuritiesInvestmentTrustCompanies-TotalSell',
    'SecuritiesInvestmentTrustCompanies-Difference',
    'Dealers-TotalBuy',
    'Dealers-TotalSell',
    'Dealers-Difference',
    'Dealers -TotalSell',
    'TotalDifference',
  ],
};

export const TPEX_MARGIN_BALANCE: SourceDescriptor = {
  id: 'tpex_margin_balance',
  url: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  market: 'TPEx',
  sourceTier: 'official_primary',
  description: '上櫃股票融資融券餘額',
  usedBy: 'P5 訊號引擎（信用交易因子）／P6 L2 否決層（籌碼面）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Date',
    'SecuritiesCompanyCode',
    'CompanyName',
    'MarginPurchaseBalancePreviousDay',
    'MarginPurchase',
    'MarginSales',
    'CashRedemption',
    'MarginPurchaseBalance',
    'MarginPurchaseBalanceBelongSecuritiesFinanceEnterprise',
    'MarginPurchaseUtilizationRate',
    'MarginPurchaseQuota',
    'ShortSaleBalancePreviousDay',
    'ShortSale',
    'ShortConvering',
    'StockRedemption',
    'ShortSaleBalance',
    'ShortSaleBalanceBelongSecuritiesFinanceEnterprise',
    'ShortSaleUtilizationRate',
    'ShortSaleQuota',
    'Offsetting',
    'Note',
  ],
};

// ── 註冊表 ───────────────────────────────────────────────────────────────────

/** P1 行情類，每個交易日收盤後抓 */
export const QUOTE_SOURCES: readonly SourceDescriptor[] = [
  TWSE_STOCK_DAY_ALL,
  TWSE_BWIBBU_ALL,
  TPEX_MAINBOARD_DAILY_CLOSE_QUOTES,
  TPEX_MAINBOARD_PERATIO_ANALYSIS,
];

/** P2 MOPS 類 */
export const MOPS_SOURCES: readonly SourceDescriptor[] = [
  MOPS_TWSE_MONTHLY_REVENUE,
  MOPS_TPEX_MONTHLY_REVENUE,
  MOPS_TWSE_COMPANY_PROFILE,
  MOPS_TPEX_COMPANY_PROFILE,
  MOPS_TWSE_MATERIAL_ANNOUNCEMENTS,
  MOPS_TPEX_MATERIAL_ANNOUNCEMENTS,
];

/** P2 TAIFEX 類 */
export const TAIFEX_SOURCES: readonly SourceDescriptor[] = [
  TAIFEX_INSTITUTIONAL_FUTURES_OPTIONS,
  TAIFEX_PUT_CALL_RATIO,
  TAIFEX_LARGE_TRADERS_FUTURES,
];

/**
 * P2.5 籌碼面。
 * ⚠️ 順序有意義：`twse_institutional_by_stock` 的網址需要日期，
 * 而日期來自 `twse_stock_day_all`（在 QUOTE_SOURCES 中，排在前面）。
 */
export const CHIP_SOURCES: readonly SourceDescriptor[] = [
  TWSE_INSTITUTIONAL_BY_STOCK,
  TWSE_MARGIN_BALANCE,
  TPEX_INSTITUTIONAL_BY_STOCK,
  TPEX_MARGIN_BALANCE,
];

// ── P6：L2 否決層所需的交易狀態公告 ─────────────────────────────────────────
//
// 全部端點於 2026-08-16 逐一實測回應 200 並記錄實際欄位，欄位名逐字照抄。
// 實測發現三個非直覺的慣例，寫在這裡是為了讓後人不必再踩一次：
//
// 1️⃣ **「當日無公告」不是空陣列，是一列全空的佔位列**
//    twse_attention 與 tpex_suspended 在無資料時回傳 1 列，
//    代號為空字串。若把列數當成「有幾檔」，會永遠多算一檔。
//    L0 只存不判斷，故照原樣存；佔位列的辨識放在 L1 正規化。
//
// 2️⃣ **tpex_suspended 的日期是西元壓縮，同組其他端點都是民國**
//    實測值 "20260816"，而 tpex_attention 同日是 "1150814"。
//    同一個交易所、同一批端點，格式不一致。故格式逐來源宣告，不共用。
//
// 3️⃣ **兩個處置端點的期間格式不同，且都不是標準日期**
//    TWSE："115/08/12～115/08/18"（斜線 + 全形波浪號）
//    TPEx："1150817~1150821"（壓縮 + 半形波浪號）
//    處置是否「現在生效」取決於這個期間，不是取決於公告日，
//    因此兩種格式都必須解析，不能只挑一種。

export const TWSE_ATTENTION: SourceDescriptor = {
  id: 'twse_attention',
  url: 'https://openapi.twse.com.tw/v1/announcement/notice',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '集中市場當日公布注意股票',
  usedBy: 'P6 L2 否決層（注意股）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  // ⚠️ 實測當日無注意股（僅佔位列，Date 為空字串），故此端點的日期格式**未能實測**。
  //    依同一批 TWSE OpenAPI 端點的一致慣例宣告為民國壓縮。
  //    若實際不是，L0 會記為 date_unparsable 並留在 source_health，不會靜默通過。
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Number',
    'Code',
    'Name',
    'NumberOfAnnouncement',
    'TradingInfoForAttention',
    'Date',
    'ClosingPrice',
    'PE',
  ],
};

/**
 * 處置股票。一次回傳近期多日的公告（實測 19 列、8 個相異日期），
 * 故 dateSelection 用 'max'。真正決定「現在是否處置中」的是 DispositionPeriod。
 */
export const TWSE_DISPOSITION: SourceDescriptor = {
  id: 'twse_disposition',
  url: 'https://openapi.twse.com.tw/v1/announcement/punish',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '集中市場公布處置股票',
  usedBy: 'P6 L2 否決層（處置股）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  dateSelection: 'max',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Number',
    'Date',
    'Code',
    'Name',
    'NumberOfAnnouncement',
    'ReasonsOfDisposition',
    'DispositionPeriod',
    'DispositionMeasures',
    'Detail',
    'LinkInformation',
  ],
};

/** ⚠️ payload 無日期欄位（實測），與 twse_margin_balance 同樣的狀況。 */
export const TWSE_SUSPENDED: SourceDescriptor = {
  id: 'twse_suspended',
  url: 'https://openapi.twse.com.tw/v1/exchangeReport/TWTAWU',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '集中市場暫停交易證券',
  usedBy: 'P6 L2 否決層（暫停交易）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  /** 空字串＝此 payload 沒有日期欄位。停復牌日期在 TradingHaltDate / TradingResumptionDate。 */
  dateField: '',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Number',
    'Code',
    'Name',
    'TradingHaltDate',
    'TradingHaltTime',
    'TradingResumptionDate',
    'TradingResumptionTime',
  ],
};

/**
 * 變更交易方法（全額交割等）。⚠️ payload 無日期欄位，且**只有三個欄位**：
 * 列的存在本身即代表該證券變更交易；PeriodicCallAuctionTrading 實測值為
 * "  "（兩個空格）或 "**"，逐字保留，不解讀成布林值。
 */
export const TWSE_ALTERED_TRADING: SourceDescriptor = {
  id: 'twse_altered_trading',
  url: 'https://openapi.twse.com.tw/v1/exchangeReport/TWT85U',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '集中市場證券變更交易',
  usedBy: 'P6 L2 否決層（變更交易／全額交割）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: '',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: ['Code', 'Name', 'PeriodicCallAuctionTrading'],
};

export const TPEX_ATTENTION: SourceDescriptor = {
  id: 'tpex_attention',
  url: 'https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information',
  market: 'TPEx',
  sourceTier: 'official_primary',
  description: '上櫃公布注意股票資訊',
  usedBy: 'P6 L2 否決層（注意股）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Date',
    'SecuritiesCompanyCode',
    'CompanyName',
    'TradingInformation',
    'ClosePrice',
    'PriceEarningRatio',
  ],
};

/** 一次回傳近期多日公告（實測 36 列、9 個相異日期），故用 'max'。 */
export const TPEX_DISPOSITION: SourceDescriptor = {
  id: 'tpex_disposition',
  url: 'https://www.tpex.org.tw/openapi/v1/tpex_disposal_information',
  market: 'TPEx',
  sourceTier: 'official_primary',
  description: '上櫃處置有價證券資訊',
  usedBy: 'P6 L2 否決層（處置股）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  dateSelection: 'max',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Date',
    'SecuritiesCompanyCode',
    'CompanyName',
    'DispositionPeriod',
    'DispositionReasons',
    'DisposalCondition',
  ],
};

/**
 * ⚠️ 兩個實測特例：
 *   - 日期是**西元**壓縮（"20260816"），與同批其他上櫃端點的民國格式不同
 *   - 欄位名中英夾雜，「暫停交易」「恢復交易」是中文，照抄
 */
export const TPEX_SUSPENDED: SourceDescriptor = {
  id: 'tpex_suspended',
  url: 'https://www.tpex.org.tw/openapi/v1/tpex_spendi_today',
  market: 'TPEx',
  sourceTier: 'official_primary',
  description: '上櫃當日公布暫停/恢復交易股票',
  usedBy: 'P6 L2 否決層（暫停交易）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  dateFormat: 'ad_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: ['Date', 'SecuritiesCompanyCode', 'CompanyName', '暫停交易', '恢復交易'],
};

/**
 * 變更交易／分盤交易／管理股票／停止交易，四種狀態同一張表。
 * ⚠️ 官方欄位 `" FinancialAnnouncements"` 開頭帶一個空格，照抄不修正。
 * ⚠️ 旗標值是**全形** Ｙ（U+FF39），不是 ASCII 的 Y。
 */
export const TPEX_ALTERED_TRADING: SourceDescriptor = {
  id: 'tpex_altered_trading',
  url: 'https://www.tpex.org.tw/openapi/v1/tpex_cmode',
  market: 'TPEx',
  sourceTier: 'official_primary',
  description: '上櫃股票變更交易、分盤交易、管理股票與停止交易資訊',
  usedBy: 'P6 L2 否決層（變更交易／管理股票／停止交易）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Date',
    'SecuritiesCompanyCode',
    'CompanyName',
    'AlteredTrading',
    'PeriodicTrading',
    'ManagedStock',
    'MatchingFrequency',
    'SuspensionOfTrading',
    ' FinancialAnnouncements', // 官方欄位名開頭帶一個空格，照抄
  ],
};

/** P6 L2 否決層所需的交易狀態公告 */
export const TRADING_STATUS_SOURCES: readonly SourceDescriptor[] = [
  TWSE_ATTENTION,
  TWSE_DISPOSITION,
  TWSE_SUSPENDED,
  TWSE_ALTERED_TRADING,
  TPEX_ATTENTION,
  TPEX_DISPOSITION,
  TPEX_SUSPENDED,
  TPEX_ALTERED_TRADING,
];

// ── P9：除權息（報酬還原用） ─────────────────────────────────────────────────
//
// CLAUDE.md：「P9 計算報酬時必須把除權息還原，丟掉這個欄位會低估報酬」。
// 台股除權息集中在 7–9 月，不還原會系統性低估整個旺季的報酬，
// 那會直接影響 G2（期望值、獲利因子）與 G3（勝過 0050）的判定。
//
// 【2026-08-16 實測：兩個交易所的「預告表」單位一致，但「計算結果表」不同】
//   上市 TWT48U_ALL        StockDividendRatio        0.10000000   每股配股率
//   上櫃 exright_prepost   StockDividendRatio        0.04990554   每股配股率　← 同單位
//   上櫃 exright_daily     StockDividend             1.547368     權值（元）　← **是金額不是比率**
//                          StockDivdendThousandShares 49.90554083  每千股配股數
// 以官方參考價反推驗證（4123 晟德）：
//   (34.30 − 1.74669) ÷ (1 + 0.0499055) = 31.0059，官方參考價 31.01 ✓
// 若誤把 exright_daily 的 StockDividend 當成配股率，會算出 12.78 —— 差了兩倍以上。
//
// 【為什麼預告表必須每日抓】
// 預告表是**前瞻**的：它列出即將到來的除權息日。過去的除權息會從表中消失。
// 因為 L0 是 append-only 且每日抓取，各日快照的**聯集**才涵蓋所有除權息事件。
// 少抓一天，那天新增的除權息就可能永遠補不回來（交易所不提供歷史查詢）。

export const TWSE_EXRIGHT_FORECAST: SourceDescriptor = {
  id: 'twse_exright_forecast',
  url: 'https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '上市股票除權除息預告表',
  usedBy: 'P9 報酬還原（除權息）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  // 一次回傳未來多個除權息日（實測 142 列、23 個相異日期）
  dateSelection: 'max',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Date',
    'Code',
    'Name',
    'Exdividend', // 官方拼法：小寫 d，非 ExDividend。值為 息／權／權息
    'StockDividendRatio',
    'SubscriptionRatio',
    'SubscriptionPricePerShare',
    'CashDividend',
    'SharesOffered',
    'SharesEmpOwner',
    'SharesholderOwner',
    'StockHoldingRatio',
  ],
};

/** ⚠️ 日期欄位是 `ExRrightsExDividendDate`（官方拼法，Rrights 有兩個 r），不是 Date。 */
export const TPEX_EXRIGHT_FORECAST: SourceDescriptor = {
  id: 'tpex_exright_forecast',
  url: 'https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost',
  market: 'TPEx',
  sourceTier: 'official_primary',
  description: '上櫃股票除權除息預告表',
  usedBy: 'P9 報酬還原（除權息）',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'ExRrightsExDividendDate',
  dateFormat: 'roc_compact',
  dateSelection: 'max',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'ExRrightsExDividendDate',
    'SecuritiesCompanyCode',
    'CompanyName',
    'ExRrightsExDividend',
    'StockDividendRatio',
    'SubscriptionRatioToNewSharesIssued',
    'SubscriptionPricePerShare',
    'CashDividend',
    'AllocatedForPublicUnderwriting',
    'SubscribedByEmployees',
    'SubscribedByExistingShareholders',
    'SubscribedProRataInThousandShares',
  ],
};

/**
 * 上櫃除權息計算結果表。**用途是交叉驗證，不是主要資料來源。**
 *
 * 它同時提供除權息前收盤價與官方參考價，因此可以拿來反推、確認我們的
 * 還原公式沒有算錯。上市在 OpenAPI 目錄查無對應端點，故此交叉驗證僅涵蓋上櫃。
 *
 * ⚠️ 官方欄位有多處拼寫錯誤，一律照抄：
 *    `ExRightsDiviend`（Diviend）／`CashDivdend`（Divdend）／`StockDivdendThousandShares`
 *    且 `CashDividend` 與 `CashDivdend` **兩個都存在**，精度不同。
 */
export const TPEX_EXRIGHT_DAILY: SourceDescriptor = {
  id: 'tpex_exright_daily',
  url: 'https://www.tpex.org.tw/openapi/v1/tpex_exright_daily',
  market: 'TPEx',
  sourceTier: 'official_primary',
  description: '上櫃股票除權除息計算結果表（交叉驗證用）',
  usedBy: 'P9 報酬還原的公式交叉驗證',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Date',
    'SecuritiesCompanyCode',
    'CompanyName',
    'ClosePriceBeforeExRightsDiviend',
    'ExRightsDiviendQuote',
    'StockDividend',
    'CashDividend',
    'StockDividendPlusCashDividend',
    'ExRightsDiviend',
    'LimitUp',
    'LimitDown',
    'OpeningReferencePrice',
    'DividendDeductedQuote',
    'CashDivdend',
    'StockDivdendThousandShares',
    'CashCapitalIncreaseShares',
    'SubscriptionPricePerShare',
    'AllocatedForPublicUnderwriting',
    'SubscribedByEmployees',
    'SubscribedByExistingShareholders',
    'SubscribedProRataThousandShares',
  ],
};

/** P9 除權息 */
export const EXRIGHT_SOURCES: readonly SourceDescriptor[] = [
  TWSE_EXRIGHT_FORECAST,
  TPEX_EXRIGHT_FORECAST,
  TPEX_EXRIGHT_DAILY,
];




// ═══════════════════════════════════════════════════════════════════════════
// P11.15：擴充公部門來源（2026-08-20 逐一實測，欄位照 API 實際回傳抄錄）
//
// 【這一批的定位】
// 除了停資停券直接進 L2 之外，其餘**只累積不使用**。
// 因子必須在看到結果之前登記，而檢定需要歷史 —— 現在不抓，P12 一樣沒得檢定；
// 但若在看過 2026-08 觀察榜的表現之後才挑因子，那就是前視偏誤。
// 兩難的解法是：資料現在存，因子等 P12 依規矩登記。
//
// 【v1 因子上限 5 個已滿，本批不新增任何因子】
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 停資停券預告。
 *
 * ⚠️ **payload 沒有「資料日期」欄位**。StartDate／EndDate 是停券的**生效期間**，
 * 不是這份 payload 的產生日 —— 拿它當 data_as_of 會把「8/27 開始停券」記成
 * 「這份資料是 8/27 的」，語意完全不同。故 dateField 留空，
 * data_as_of 如實記為 null、原因 date_field_missing。
 *
 * 【為什麼這個要進 L2】
 * 停資停券直接抽掉一檔股票的槓桿資金。原因欄常見「股價波動過度劇烈」，
 * 那正是我們不想在此時進場的狀態。與處置／注意股同屬官方已公告的事實，
 * 可回溯、可驗證，符合 L2「只能否決」與「須附官方原文」的要求。
 */
export const TWSE_MARGIN_SUSPENSION: SourceDescriptor = {
  id: 'twse_margin_suspension',
  url: 'https://openapi.twse.com.tw/v1/exchangeReport/BFI84U',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '集中市場停資停券預告表',
  usedBy: 'P11.15 L2 否決層（停資停券期間不進場）',
  verifiedAt: '2026-08-20',
  payloadShape: 'json_array',
  /** 空字串＝此 payload 沒有資料日期欄位（見上方說明），不是漏填 */
  dateField: '',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: ['Code', 'Name', 'StartDate', 'EndDate', 'Reason'],
};

/**
 * 發行量加權股價報酬指數（含息）。
 *
 * 【為什麼要它，明明已經有 0050】
 * 0050 是 ETF，有折溢價、有管理費、有追蹤誤差。
 * 這支是交易所自己算的**含息**市場報酬，是更乾淨的基準。
 * 兩個都留：0050 代表「你真的買得到的東西」，報酬指數代表「市場本身」。
 * G3 判準不因此放寬 —— 多一個對照組只會讓標準更難達成，不會更容易。
 *
 * 一次回傳近 13 個交易日的滾動視窗，故 dateSelection 為 max。
 */
export const TWSE_TAIEX_TOTAL_RETURN: SourceDescriptor = {
  id: 'twse_taiex_total_return',
  url: 'https://openapi.twse.com.tw/v1/indicesReport/MFI94U',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '發行量加權股價報酬指數（含息）',
  usedBy: 'P11.15 G3 市場基準（與 0050 併列對照）',
  verifiedAt: '2026-08-20',
  payloadShape: 'json_array',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  /** 一次回傳近 13 個交易日，非單日快照 */
  dateSelection: 'max',
  periodField: null,
  periodFormat: null,
  baselineFields: ['Date', 'TAIEXTotalReturnIndex'],
};

/**
 * 上市上櫃股票當日可借券賣出股數。
 *
 * 【為什麼補這個】
 * 台股的機構放空主要走**借券**不走融券。只看融券餘額，等於漏掉法人的空單。
 * 一份只有散戶空單的空方圖像，會系統性低估真實的賣壓。
 *
 * ⚠️ 同一份 payload 同時含上市（TWSECode）與上櫃（GRETAICode）兩組欄位，
 *    且**沒有日期欄位** —— 與 twse_margin_balance 同樣的處理方式。
 * ⚠️ 官方欄位名 GRETAI 是櫃買中心的舊英文名（GreTai Securities Market），照抄不改。
 */
export const TWSE_SBL_AVAILABLE: SourceDescriptor = {
  id: 'twse_sbl_available',
  url: 'https://openapi.twse.com.tw/v1/SBL/TWT96U',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '上市上櫃股票當日可借券賣出股數',
  usedBy: 'P12 因子候選（空方部位）—— 目前只累積，不使用',
  verifiedAt: '2026-08-20',
  payloadShape: 'json_array',
  /** 空字串＝此 payload 沒有日期欄位，不是漏填 */
  dateField: '',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: ['TWSECode', 'TWSEAvailableVolume', 'GRETAICode', 'GRETAIAvailableVolume'],
};

/**
 * 上市公司營益分析彙總表（毛利率／營業利益率／稅前純益率／稅後純益率）。
 *
 * 【為什麼這個重要】
 * 我們現在有「月營收年增率」因子，但營收成長不等於賺錢 ——
 * 營收暴增而毛利率同時崩跌，是賠本搶單。只看營收會被騙，這是那個故事的另一半。
 *
 * ⚠️ **資料期間是「年度」＋「季別」兩個欄位**（實測：年度=115、季別=2），
 *    而 SourcePeriodFormat 目前只支援單一欄位的 roc_year_month，表達不了「季」。
 *    故 periodField 宣告為 null —— **不是漏填，是這個規格現在表達不了**。
 *    原始 payload 完整保留兩欄，P12 實際使用時由 L1 讀取並明確記錄推導過程。
 *    在那之前不假裝 data_period 有值。
 * ⚠️ 欄位名含算式與括號，照抄不簡化。
 */
export const TWSE_PROFITABILITY: SourceDescriptor = {
  id: 'twse_profitability',
  url: 'https://openapi.twse.com.tw/v1/opendata/t187ap17_L',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '上市公司營益分析彙總表（毛利率／營益率／純益率）',
  usedBy: 'P12 因子候選（獲利品質）—— 目前只累積，不使用',
  verifiedAt: '2026-08-20',
  payloadShape: 'json_array',
  dateField: '出表日期',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  /** 期間是「年度＋季別」兩欄，現行規格表達不了「季」，故留 null（見上方說明） */
  periodField: null,
  periodFormat: null,
  baselineFields: [
    '出表日期',
    '年度',
    '季別',
    '公司代號',
    '公司名稱',
    '營業收入(百萬元)',
    '毛利率(%)(營業毛利)/(營業收入)',
    '營業利益率(%)(營業利益)/(營業收入)',
    '稅前純益率(%)(稅前純益)/(營業收入)',
    '稅後純益率(%)(稅後純益)/(營業收入)',
  ],
};

/**
 * 上市公司董監事持股餘額明細（含設質股數與設質比例）。
 *
 * 【台股特有的風險指標，美股沒有對應物】
 * 董監把持股拿去質押借錢，股價下跌到一定程度會被要求補繳保證金；
 * 補不出來就會被斷頭賣出，而賣出又進一步壓低股價 ——
 * **那是一個會自我強化的下跌螺旋**。高質押比例的個股在下跌時特別危險。
 *
 * ⚠️ 官方欄位「選任時持股 」**結尾帶一個空格**，照抄不修正
 *    （與 TWSE 重大訊息的「主旨 」是同一類情形）。
 * ⚠️ 27,528 列，是目前所有來源中最大的一支。
 */
export const TWSE_DIRECTOR_HOLDINGS: SourceDescriptor = {
  id: 'twse_director_holdings',
  url: 'https://openapi.twse.com.tw/v1/opendata/t187ap11_L',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '上市公司董監事持股餘額明細（含設質比例）',
  usedBy: 'P12 因子候選與 L2 風險旗標（董監質押）—— 目前只累積，不使用',
  verifiedAt: '2026-08-20',
  payloadShape: 'json_array',
  dateField: '出表日期',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: '資料年月',
  periodFormat: 'roc_year_month',
  baselineFields: [
    '出表日期',
    '資料年月',
    '公司代號',
    '公司名稱',
    '職稱',
    '姓名',
    '選任時持股 ',
    '目前持股',
    '設質股數',
    '設質股數佔持股比例',
    '內部人關係人目前持股合計',
    '內部人關係人設質股數',
    '內部人關係人設質比例',
  ],
};

/**
 * 各類指數收盤行情（實測 273 個指數，含加權指數、半導體、金融保險等類股指數）。
 *
 * 【為什麼專業交易員一定看類股】
 * 個股報酬有相當比例來自所屬類股與大盤，不是個股本身。
 * 強勢股在崩跌的類股裡照樣被拖下去。只看個股不看類股，等於少看一半的資訊。
 *
 * ⚠️ 官方把**漲跌方向與幅度拆成兩欄**：「漲跌」是符號（實測為減號），
 *    「漲跌點數」是絕對值。兩欄必須一起讀，只讀點數會把跌當成漲。
 */
export const TWSE_SECTOR_INDICES: SourceDescriptor = {
  id: 'twse_sector_indices',
  url: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '每日收盤行情——各類指數（實測 273 個）',
  usedBy: 'P12 因子候選（類股相對強弱）—— 目前只累積，不使用',
  verifiedAt: '2026-08-20',
  payloadShape: 'json_array',
  dateField: '日期',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: ['日期', '指數', '收盤指數', '漲跌', '漲跌點數', '漲跌百分比', '特殊處理註記'],
};

/**
 * 集中市場每日成交資訊（成交量、成交金額、筆數、加權指數）。
 *
 * 【用途】市場整體活絡程度。個股成交量要放在大盤量能的脈絡下看 ——
 * 全市場都在縮量時，個股「量縮」不代表這檔特別冷清。
 * 另外此處的 TAIEX 是**價格指數**，與 twse_taiex_total_return 的含息指數不同，
 * 兩者相減即為配息貢獻，不可混用。
 *
 * 一次回傳近 13 個交易日的滾動視窗，故 dateSelection 為 max。
 */
export const TWSE_MARKET_TURNOVER: SourceDescriptor = {
  id: 'twse_market_turnover',
  url: 'https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '集中市場每日成交資訊（量、值、筆數、加權指數）',
  usedBy: 'P12 因子候選（量能脈絡）—— 目前只累積，不使用',
  verifiedAt: '2026-08-20',
  payloadShape: 'json_array',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  /** 一次回傳近 13 個交易日，非單日快照 */
  dateSelection: 'max',
  periodField: null,
  periodFormat: null,
  baselineFields: ['Date', 'TradeVolume', 'TradeValue', 'Transaction', 'TAIEX', 'Change'],
};

/**
 * 期貨每日交易行情（實測 2,357 列，含台指期各月份與各商品）。
 *
 * 【期現價差是台股特有的重要指標】
 * 台指期收盤低於加權指數（逆價差）代表法人在避險或看空後市。
 * 美股看 futures basis 與 term structure，台股的逆價差訊號更直接，
 * 因為台指期的法人參與度高而散戶投機成分相對可辨識。
 *
 * ⚠️ **日期格式是西元壓縮（實測 20260819），不是民國** ——
 *    與 TWSE 那一批不同，期交所用西元。宣告錯會整批解析失敗。
 * ⚠️ 欄位名含百分號與括號，照抄不簡化。
 */
export const TAIFEX_DAILY_FUTURES: SourceDescriptor = {
  id: 'taifex_daily_futures',
  url: 'https://openapi.taifex.com.tw/v1/DailyMarketReportFut',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  market: 'TAIFEX',
  sourceTier: 'official_primary',
  description: '期貨每日交易行情（含未平倉與結算價）',
  usedBy: 'P12 因子候選（期現價差）—— 目前只累積，不使用',
  verifiedAt: '2026-08-20',
  payloadShape: 'json_array',
  dateField: 'Date',
  /** 期交所用西元壓縮，與 TWSE 的民國不同 */
  dateFormat: 'ad_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
  baselineFields: [
    'Date',
    'Contract',
    'ContractMonth(Week)',
    'Open',
    'High',
    'Low',
    'Last',
    'Change',
    '%',
    'Volume',
    'SettlementPrice',
    'OpenInterest',
    'BestBid',
    'BestAsk',
    'HistoricalHigh',
    'HistoricalLow',
    'TradingHalt',
    'TradingSession',
    'Volume(ExecutionsAmongSpreadOrderAndSingleOrderOnly)',
  ],
};

/**
 * P11.15 擴充來源。分成獨立一組，因為它們的使用狀態與其他組不同：
 * 只有 twse_margin_suspension 進 L2，其餘七個目前**只累積不使用**。
 * 混進既有分組會讓「哪些已在用」變得看不出來。
 */
export const EXTENDED_SOURCES: readonly SourceDescriptor[] = [
  TWSE_MARGIN_SUSPENSION,
  TWSE_TAIEX_TOTAL_RETURN,
  TWSE_SBL_AVAILABLE,
  TWSE_PROFITABILITY,
  TWSE_DIRECTOR_HOLDINGS,
  TWSE_SECTOR_INDICES,
  TWSE_MARKET_TURNOVER,
  TAIFEX_DAILY_FUTURES,
];

export const ALL_SOURCES: readonly SourceDescriptor[] = [
  ...QUOTE_SOURCES,
  ...MOPS_SOURCES,
  ...TAIFEX_SOURCES,
  ...CHIP_SOURCES,
  ...TRADING_STATUS_SOURCES,
  ...EXRIGHT_SOURCES,
  ...EXTENDED_SOURCES,
];

/**
 * 註冊表放在檔案最後：所有描述子皆為 const，沒有提升，
 * 放在前面會 TS2448（used before its declaration）。
 */
export const SOURCES_BY_ID: Readonly<Record<SourceId, SourceDescriptor>> = {
  twse_stock_day_all: TWSE_STOCK_DAY_ALL,
  twse_bwibbu_all: TWSE_BWIBBU_ALL,
  tpex_mainboard_daily_close_quotes: TPEX_MAINBOARD_DAILY_CLOSE_QUOTES,
  tpex_mainboard_peratio_analysis: TPEX_MAINBOARD_PERATIO_ANALYSIS,
  mops_twse_monthly_revenue: MOPS_TWSE_MONTHLY_REVENUE,
  mops_tpex_monthly_revenue: MOPS_TPEX_MONTHLY_REVENUE,
  mops_twse_company_profile: MOPS_TWSE_COMPANY_PROFILE,
  mops_tpex_company_profile: MOPS_TPEX_COMPANY_PROFILE,
  mops_twse_material_announcements: MOPS_TWSE_MATERIAL_ANNOUNCEMENTS,
  mops_tpex_material_announcements: MOPS_TPEX_MATERIAL_ANNOUNCEMENTS,
  taifex_institutional_futures_options: TAIFEX_INSTITUTIONAL_FUTURES_OPTIONS,
  taifex_put_call_ratio: TAIFEX_PUT_CALL_RATIO,
  taifex_large_traders_futures: TAIFEX_LARGE_TRADERS_FUTURES,
  twse_institutional_by_stock: TWSE_INSTITUTIONAL_BY_STOCK,
  twse_margin_balance: TWSE_MARGIN_BALANCE,
  tpex_institutional_by_stock: TPEX_INSTITUTIONAL_BY_STOCK,
  tpex_margin_balance: TPEX_MARGIN_BALANCE,
  twse_attention: TWSE_ATTENTION,
  twse_disposition: TWSE_DISPOSITION,
  twse_suspended: TWSE_SUSPENDED,
  twse_altered_trading: TWSE_ALTERED_TRADING,
  tpex_attention: TPEX_ATTENTION,
  tpex_disposition: TPEX_DISPOSITION,
  tpex_suspended: TPEX_SUSPENDED,
  tpex_altered_trading: TPEX_ALTERED_TRADING,
  twse_exright_forecast: TWSE_EXRIGHT_FORECAST,
  tpex_exright_forecast: TPEX_EXRIGHT_FORECAST,
  tpex_exright_daily: TPEX_EXRIGHT_DAILY,
  // P11.15：擴充公部門來源（僅停資停券進 L2，其餘只累積）
  twse_margin_suspension: TWSE_MARGIN_SUSPENSION,
  twse_taiex_total_return: TWSE_TAIEX_TOTAL_RETURN,
  twse_sbl_available: TWSE_SBL_AVAILABLE,
  twse_profitability: TWSE_PROFITABILITY,
  twse_director_holdings: TWSE_DIRECTOR_HOLDINGS,
  twse_sector_indices: TWSE_SECTOR_INDICES,
  twse_market_turnover: TWSE_MARKET_TURNOVER,
  taifex_daily_futures: TAIFEX_DAILY_FUTURES,
};
