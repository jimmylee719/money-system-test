/**
 * 費率常數與法規依據。
 *
 * ⚠️ 每季覆核（CLAUDE.md 規定）。最後查證日：2026-08-16。
 * 任何數字若查無官方來源，一律不寫死，改為 BrokerFeeConfig 輸入參數。
 */

import { assertValidIsoDate } from '../shared/calendar';
import type { BrokerFeeConfig, RoundingMode, TradeType } from './types';

/**
 * 手續費費率上限 1.425‰（= 1425 ppm）。
 *
 * 來源：臺灣證券交易所「證券商受託買賣有價證券手續費費率公告」，
 *       民國97年2月1日公告、97年2月12日實施。
 *       https://www.twse.com.tw/staticFiles/marketAnnounce/setAnnounce/0970003165.htm
 *
 * 【重要】這是「上限」不是固定費率。券商得於上限內自訂費率標準及折讓標準，
 * 因此本模組不把它當常數使用，只用來驗證 BrokerFeeConfig 是否逾上限。
 *
 * 殘餘風險：未找到 2008 年後的現行正式條文頁面（證交所法規庫 FE064320 為民國80年
 * 函釋，且依金管會公告自民國110年10月1日起不再援用）。此上限值需每季覆核。
 */
export const COMMISSION_RATE_CAP_PPM = 1425;

/**
 * 股票證券交易稅 3‰（= 3000 ppm），向出賣有價證券人按成交價格課徵。
 *
 * 來源：證券交易稅條例 第2條 第1款
 *       「公司發行之股票及表明股票權利之證書或憑證徵千分之三」
 *       https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=G0340078&flno=2
 */
export const TAX_RATE_STOCK_PPM = 3000;

/**
 * 現股當沖證券交易稅減半 1.5‰（= 1500 ppm）。
 *
 * 來源：證券交易稅條例 第2條之2
 *       https://law.moj.gov.tw/LawClass/LawSingle.aspx?flno=2-2&pcode=G0340078
 *
 * ⚠️ CLAUDE.md 明令禁止當沖。本常數僅供成本比較，任何 day_trade 路徑都會回傳 warning。
 */
export const TAX_RATE_DAY_TRADE_PPM = 1500;

/** 當沖證交稅減半施行期間起日（經紀買賣）。來源同 §2-2。 */
export const DAY_TRADE_HALVING_START = '2017-04-28';

/** 當沖證交稅減半施行期間迄日。來源同 §2-2。 */
export const DAY_TRADE_HALVING_END = '2027-12-31';

export const PPM_DIVISOR = 1_000_000n;
export const BPS_DIVISOR = 10_000n;

const VALID_ROUNDING_MODES: readonly RoundingMode[] = ['floor', 'ceil', 'half_up'];

/** 驗證 'YYYY-MM-DD' 且必須是真實存在的日期 */
export function assertValidTradeDate(tradeDate: string): void {
  assertValidIsoDate(tradeDate, 'tradeDate');
}

/**
 * 依交易類型與交易日決定賣出證交稅率。
 * 逾減半施行期間自動退回一般稅率並發出 warning——不做任何延長期限的推定。
 */
export function resolveSellTaxRatePpm(
  tradeType: TradeType,
  tradeDate: string,
): { readonly ratePpm: number; readonly warnings: readonly string[] } {
  assertValidTradeDate(tradeDate);

  if (tradeType === 'normal') {
    return { ratePpm: TAX_RATE_STOCK_PPM, warnings: [] };
  }

  const warnings: string[] = [
    'day_trade：CLAUDE.md 禁止當沖，此模式僅供成本比較，不得據以產生交易訊號。',
  ];

  // ISO 日期字串可直接做字典序比較
  if (tradeDate < DAY_TRADE_HALVING_START || tradeDate > DAY_TRADE_HALVING_END) {
    warnings.push(
      `交易日 ${tradeDate} 不在證交稅減半施行期間（${DAY_TRADE_HALVING_START} ~ ` +
        `${DAY_TRADE_HALVING_END}，證券交易稅條例 §2-2），已改用一般稅率 ` +
        `${TAX_RATE_STOCK_PPM} ppm。`,
    );
    return { ratePpm: TAX_RATE_STOCK_PPM, warnings };
  }

  return { ratePpm: TAX_RATE_DAY_TRADE_PPM, warnings };
}

function assertIntInRange(value: number, name: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer, got ${String(value)}`);
  }
  if (value < min || value > max) {
    throw new RangeError(`${name} must be within [${min}, ${max}], got ${value}`);
  }
}

/** 券商設定驗證。逾法定手續費上限即拒絕。 */
export function assertValidBrokerConfig(config: BrokerFeeConfig): void {
  assertIntInRange(config.commissionRatePpm, 'commissionRatePpm', 0, COMMISSION_RATE_CAP_PPM);
  assertIntInRange(config.discountBps, 'discountBps', 0, 10_000);
  assertIntInRange(config.minCommissionTwd, 'minCommissionTwd', 0, Number.MAX_SAFE_INTEGER);

  if (!VALID_ROUNDING_MODES.includes(config.commissionRounding)) {
    throw new RangeError(`invalid commissionRounding: ${String(config.commissionRounding)}`);
  }
  if (!VALID_ROUNDING_MODES.includes(config.taxRounding)) {
    throw new RangeError(`invalid taxRounding: ${String(config.taxRounding)}`);
  }
  if (config.dayTradeDiscountBps !== undefined) {
    assertIntInRange(config.dayTradeDiscountBps, 'dayTradeDiscountBps', 0, 10_000);
  }
}
