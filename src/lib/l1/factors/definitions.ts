/**
 * v1 因子定義。**這是唯一的真相來源。**
 *
 * 同一份定義物件同時餵給兩件事：
 *   1. 登記到 factor_registry（其 SHA-256 即 definition_hash）
 *   2. 因子計算引擎（讀同一份物件決定怎麼算）
 *
 * 因此「登記的」與「計算的」在結構上不可能不一致。
 * 若有人改了這裡的任何一個字，definition_hash 就會變，
 * 寫檢定結果時資料庫觸發器會直接擋下來並指出雜湊不符。
 *
 * ⚠️ **登記後不得修改**。CLAUDE.md：定義鎖定不得調參，失敗即封存不得改條件重測。
 * 要調整參數只能登記成新因子（新的 factor_key 與新的 definition_hash），
 * 而那會如實計入 DSR 的試驗次數。
 *
 * 【為什麼是前瞻檢定而不是回測】
 * 交易所 OpenAPI 只提供最新一日，本系統的 L0 自 2026-08-14 才開始累積，
 * 沒有歷史資料可回測。因此檢定期間設在未來：2026-08-17 ~ 2027-02-17。
 * 前瞻檢定在結構上不可能有前視偏誤——定義在看到任何一天結果之前就已寫死。
 */

import type { FactorRegistrationInput } from '../../factors/types';

/** 全部因子共用的檢定期間，對齊 G1 的「≥6 個月」 */
export const TEST_PERIOD_START = '2026-08-17';
export const TEST_PERIOD_END = '2027-02-17';

/** CLAUDE.md 明訂門檻，不得事後放寬 */
export const T_THRESHOLD = 3.0;

export const REGISTERED_BY = 'jimmy';

/** 去極端值：上下 1% 縮尾。所有因子一致，避免逐因子調參。 */
const WINSORIZE = { lower_pct: 1, upper_pct: 99 } as const;

/**
 * 所有因子共用的資料有效性條件。
 * 這是**資料是否可用**的判定，不是投資判斷——
 * 流動性門檻、注意處置股等會影響行動的判斷屬於 L2 否決層。
 */
const BASE_VALIDITY = ['quote.close != null', 'quote.close > 0', 'quote.volumeShares > 0'] as const;

export const REV_YOY_MOMENTUM_V1: FactorRegistrationInput = {
  factorKey: 'rev_yoy_momentum_v1',
  displayName: '月營收年增率動能',
  definition: {
    spec_version: 1,
    inputs: ['mops_twse_monthly_revenue', 'mops_tpex_monthly_revenue'],
    value: 'monthly_revenue.yoyPct',
    cross_section: 'TWSE+TPEx 合併橫斷面排序',
    winsorize: WINSORIZE,
    validity: [...BASE_VALIDITY, 'monthly_revenue.yoyPct != null'],
    as_of_rule: '使用 reportDate 不晚於當日的最新一期，禁止使用尚未公布的期別',
  },
  economicRationale:
    '月營收依法須於次月十日前公布，是最早也最高頻的營運事實，領先獲利數字一季以上。' +
    '市場對營收資訊的反應存在遞延，因為分析師覆蓋不足的中小型股需要時間讓資訊擴散。' +
    '且營收為強制申報、公布時點固定，個別公司無法擇時操縱發布時機，故不易被人為扭曲。',
  hypothesisDirection: 'higher_is_better',
  testPeriodStart: TEST_PERIOD_START,
  testPeriodEnd: TEST_PERIOD_END,
  tThreshold: T_THRESHOLD,
  universe: 'BOTH',
  registeredBy: REGISTERED_BY,
};

export const TRUST_NET_BUY_RATIO_V1: FactorRegistrationInput = {
  factorKey: 'trust_net_buy_ratio_v1',
  displayName: '投信買超佔成交量比重',
  definition: {
    spec_version: 1,
    inputs: [
      'twse_institutional_by_stock',
      'tpex_institutional_by_stock',
      'twse_stock_day_all',
      'tpex_mainboard_daily_close_quotes',
    ],
    value: 'institutional.trustNet / quote.volumeShares',
    cross_section: 'TWSE+TPEx 合併橫斷面排序',
    winsorize: WINSORIZE,
    validity: [...BASE_VALIDITY, 'institutional.trustNet != null'],
    as_of_rule: '法人資料與行情須為同一 data_as_of',
  },
  economicRationale:
    '投信為國內主動型基金，有明確的績效評比壓力與相對集中的持股期間。' +
    '基金建倉必須分批進行以免衝擊價格，因此單日買超常延續數日，形成可預期的後續買盤。' +
    '以成交量標準化可避免因子退化為只選大型股。相對外資，投信規模較小且選股集中於' +
    '中小型股，對價格的影響較為持久。',
  hypothesisDirection: 'higher_is_better',
  testPeriodStart: TEST_PERIOD_START,
  testPeriodEnd: TEST_PERIOD_END,
  tThreshold: T_THRESHOLD,
  universe: 'BOTH',
  registeredBy: REGISTERED_BY,
};

export const MARGIN_BALANCE_CHANGE_V1: FactorRegistrationInput = {
  factorKey: 'margin_balance_change_v1',
  displayName: '融資餘額日增率',
  definition: {
    spec_version: 1,
    inputs: ['twse_margin_balance', 'tpex_margin_balance'],
    value: '(margin.marginBalance - margin.marginBalancePrevDay) / margin.marginBalancePrevDay',
    cross_section: 'TWSE+TPEx 合併橫斷面排序',
    winsorize: WINSORIZE,
    validity: [...BASE_VALIDITY, 'margin.marginBalancePrevDay > 0', 'margin.marginBalance != null'],
    as_of_rule:
      'twse_margin_balance 的 payload 無日期欄位，L1 以同一次抓取的行情 data_as_of 對應，' +
      '此對應為 L1 明確做出的推論並記錄於此',
  },
  economicRationale:
    '融資餘額代表以槓桿持有的散戶部位。融資快速增加意味追價買盤集中且持有成本偏高，' +
    '一旦股價下跌，維持率不足會觸發追繳與斷頭，形成非自願賣壓。' +
    '這是結構性的下檔風險來源，與情緒判斷無關，故融資增幅大者後續報酬分布較差。',
  hypothesisDirection: 'lower_is_better',
  testPeriodStart: TEST_PERIOD_START,
  testPeriodEnd: TEST_PERIOD_END,
  tThreshold: T_THRESHOLD,
  universe: 'BOTH',
  registeredBy: REGISTERED_BY,
};

export const SHORT_TERM_REVERSAL_5D_V1: FactorRegistrationInput = {
  factorKey: 'short_term_reversal_5d_v1',
  displayName: '五日累積報酬反轉',
  definition: {
    spec_version: 1,
    inputs: ['twse_stock_day_all', 'tpex_mainboard_daily_close_quotes'],
    value: 'quote.close[t] / quote.close[t-5] - 1',
    lookback_trading_days: 5,
    cross_section: 'TWSE+TPEx 合併橫斷面排序',
    winsorize: WINSORIZE,
    validity: [
      ...BASE_VALIDITY,
      '回溯期間內 5 個交易日皆有收盤價',
      '回溯期間內任一日有除權息註記者，該檔當期排除',
    ],
    as_of_rule: '回溯以實際存在的交易日快照為準，不以日曆日推算',
  },
  economicRationale:
    '短期價格反轉源於流動性提供者的補償。當大額賣單衝擊價格時，願意接手的一方會要求' +
    '折價作為承擔存貨風險的補償，價格在數日內回歸。此效應在流動性較差的中小型股更明顯。' +
    '這是市場微結構的機制，而非跌多了會反彈的直覺推論。',
  hypothesisDirection: 'lower_is_better',
  testPeriodStart: TEST_PERIOD_START,
  testPeriodEnd: TEST_PERIOD_END,
  tThreshold: T_THRESHOLD,
  universe: 'BOTH',
  registeredBy: REGISTERED_BY,
};

export const FOREIGN_NET_BUY_RATIO_V1: FactorRegistrationInput = {
  factorKey: 'foreign_net_buy_ratio_v1',
  displayName: '外資買超佔成交量比重',
  definition: {
    spec_version: 1,
    inputs: [
      'twse_institutional_by_stock',
      'tpex_institutional_by_stock',
      'twse_stock_day_all',
      'tpex_mainboard_daily_close_quotes',
    ],
    value: 'institutional.foreignNet / quote.volumeShares',
    cross_section: 'TWSE+TPEx 合併橫斷面排序',
    winsorize: WINSORIZE,
    validity: [...BASE_VALIDITY, 'institutional.foreignNet != null'],
    as_of_rule: '法人資料與行情須為同一 data_as_of',
  },
  economicRationale:
    '外資與投信同為法人但性質不同：外資部位較大、換手較慢，且相當比例為指數與被動資金，' +
    '買超反映資金流入而非個股判斷。本因子與投信因子並列登記，用於檢驗籌碼效應是否為' +
    '投信特有：若投信通過而外資未通過，即為效應具投資人類型特異性的證據。',
  hypothesisDirection: 'higher_is_better',
  testPeriodStart: TEST_PERIOD_START,
  testPeriodEnd: TEST_PERIOD_END,
  tThreshold: T_THRESHOLD,
  universe: 'BOTH',
  registeredBy: REGISTERED_BY,
};

/** v1 因子清單。CLAUDE.md：v1 最多 5 個因子。 */
export const V1_FACTORS: readonly FactorRegistrationInput[] = [
  REV_YOY_MOMENTUM_V1,
  TRUST_NET_BUY_RATIO_V1,
  MARGIN_BALANCE_CHANGE_V1,
  SHORT_TERM_REVERSAL_5D_V1,
  FOREIGN_NET_BUY_RATIO_V1,
];
