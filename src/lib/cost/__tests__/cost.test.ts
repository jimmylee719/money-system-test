/**
 * P0 驗證閘門：手算案例 vs 程式輸出。
 *
 * 每個 describe 區塊上方的註解就是逐步手算過程；
 * 底下的 expect 是程式實際輸出。兩者必須逐格一致。
 *
 * 共用券商設定 BROKER_60：
 *   手續費率 1425 ppm（法定上限）× 折讓 6000 bps（6 折）= 有效費率 0.0855%
 *   最低手續費 20 元；手續費與證交稅皆「元以下無條件捨去」(floor)
 */

import { describe, expect, it } from 'vitest';
import {
  calcBreakevenPrice,
  calcCommission,
  calcRoundTripCost,
  calcSecuritiesTransactionTax,
  calcTradeOutcome,
} from '../cost';
import type { BrokerFeeConfig } from '../types';

const BROKER_60: BrokerFeeConfig = {
  commissionRatePpm: 1425,
  discountBps: 6000,
  minCommissionTwd: 20,
  commissionRounding: 'floor',
  taxRounding: 'floor',
};

const TRADE_DATE = '2026-08-14';

/**
 * 案例 1 — 一般交易，標準路徑
 * 進場 100.00 × 1000 股，出場 105.00
 *
 * 買進金額 = 100.00 × 1000                        = 100,000.00
 * 買進手續費 = 100,000 × 0.001425 × 0.6 = 85.5     → floor → 85
 * 賣出金額 = 105.00 × 1000                        = 105,000.00
 * 賣出手續費 = 105,000 × 0.001425 × 0.6 = 89.775   → floor → 89
 * 證交稅     = 105,000 × 0.003        = 315.0      → floor → 315
 * 總成本     = 85 + 89 + 315                       = 489
 * 毛損益     = 105,000 − 100,000                   = 5,000
 * 淨損益     = 5,000 − 489                         = 4,511
 * 成本佔比   = 489 ÷ 100,000 × 10,000 = 48.9 bps   → half_up → 49
 */
describe('案例 1：一般交易 100.00 → 105.00 × 1000 股', () => {
  const cost = calcRoundTripCost({
    entryPrice: '100.00',
    exitPrice: '105.00',
    shares: 1000,
    tradeType: 'normal',
    broker: BROKER_60,
    tradeDate: TRADE_DATE,
  });

  it('金額與費用逐項符合手算', () => {
    expect(cost.buyAmount.twd).toBe('100000.00');
    expect(cost.sellAmount.twd).toBe('105000.00');
    expect(cost.buyCommission.twd).toBe('85.00');
    expect(cost.sellCommission.twd).toBe('89.00');
    expect(cost.tax.twd).toBe('315.00');
    expect(cost.taxRatePpm).toBe(3000);
  });

  it('未觸發最低手續費', () => {
    expect(cost.buyCommissionHitFloor).toBe(false);
    expect(cost.sellCommissionHitFloor).toBe(false);
  });

  it('損益與成本佔比符合手算', () => {
    expect(cost.totalCost.twd).toBe('489.00');
    expect(cost.grossPnl.twd).toBe('5000.00');
    expect(cost.netPnl.twd).toBe('4511.00');
    expect(cost.costRatioBps).toBe(49);
    expect(cost.warnings).toHaveLength(0);
  });
});

/**
 * 案例 2 — 小額，兩邊都觸發最低手續費（邊界情況）
 * 進場 10.50 × 100 股，出場 11.00
 *
 * 買進金額 = 10.50 × 100                          = 1,050.00
 * 買進手續費 = 1,050 × 0.001425 × 0.6 = 0.89775    → floor → 0 → 低於最低 20 → 20
 * 賣出金額 = 11.00 × 100                          = 1,100.00
 * 賣出手續費 = 1,100 × 0.001425 × 0.6 = 0.9405     → floor → 0 → 低於最低 20 → 20
 * 證交稅     = 1,100 × 0.003 = 3.3                 → floor → 3
 * 總成本     = 20 + 20 + 3                         = 43
 * 毛損益     = 1,100 − 1,050                       = 50
 * 淨損益     = 50 − 43                             = 7      ← 帳面賺 50，實拿 7
 * 成本佔比   = 43 ÷ 1,050 × 10,000 = 409.52 bps    → half_up → 410 (4.10%)
 */
describe('案例 2：小額觸發最低手續費 10.50 → 11.00 × 100 股', () => {
  const cost = calcRoundTripCost({
    entryPrice: '10.50',
    exitPrice: '11.00',
    shares: 100,
    tradeType: 'normal',
    broker: BROKER_60,
    tradeDate: TRADE_DATE,
  });

  it('兩邊手續費都被最低額撐起', () => {
    expect(cost.buyCommission.twd).toBe('20.00');
    expect(cost.sellCommission.twd).toBe('20.00');
    expect(cost.buyCommissionHitFloor).toBe(true);
    expect(cost.sellCommissionHitFloor).toBe(true);
  });

  it('損益與成本佔比符合手算', () => {
    expect(cost.tax.twd).toBe('3.00');
    expect(cost.totalCost.twd).toBe('43.00');
    expect(cost.grossPnl.twd).toBe('50.00');
    expect(cost.netPnl.twd).toBe('7.00');
    expect(cost.costRatioBps).toBe(410);
  });

  it('單邊手續費函式獨立驗證亦一致', () => {
    const buy = calcCommission('10.50', 100, BROKER_60, 'normal');
    expect(buy.fee.twd).toBe('20.00');
    expect(buy.hitFloor).toBe(true);
  });
});

/**
 * 案例 3 — 現股當沖對照（本系統禁止當沖，僅供成本比較）
 * 進場 100.00 × 1000 股，出場 105.00，交易日 2026-08-14（在減半期間內）
 *
 * 手續費同案例 1：85 + 89 = 174
 * 證交稅 = 105,000 × 0.0015 = 157.5                → floor → 157
 * 總成本 = 174 + 157                               = 331
 * 淨損益 = 5,000 − 331                             = 4,669
 * 與案例 1 差額 = 4,669 − 4,511 = 158（= 315 − 157）
 */
describe('案例 3：現股當沖 100.00 → 105.00 × 1000 股', () => {
  const cost = calcRoundTripCost({
    entryPrice: '100.00',
    exitPrice: '105.00',
    shares: 1000,
    tradeType: 'day_trade',
    broker: BROKER_60,
    tradeDate: TRADE_DATE,
  });

  it('證交稅減半為 1500 ppm', () => {
    expect(cost.taxRatePpm).toBe(1500);
    expect(cost.tax.twd).toBe('157.00');
  });

  it('總成本與淨損益符合手算', () => {
    expect(cost.totalCost.twd).toBe('331.00');
    expect(cost.netPnl.twd).toBe('4669.00');
  });

  it('必定回傳禁止當沖的 warning', () => {
    expect(cost.warnings).toHaveLength(1);
    expect(cost.warnings[0]).toContain('禁止當沖');
  });

  it('與一般交易的差額等於證交稅差額', () => {
    const normal = calcRoundTripCost({
      entryPrice: '100.00',
      exitPrice: '105.00',
      shares: 1000,
      tradeType: 'normal',
      broker: BROKER_60,
      tradeDate: TRADE_DATE,
    });
    expect(cost.netPnl.cents - normal.netPnl.cents).toBe(15800n); // 158.00 元
  });
});

/**
 * 案例 4 — 當沖但交易日逾減半施行期限（證券交易稅條例 §2-2 至 2027-12-31）
 * 交易日 2028-01-05 → 稅率退回 3000 ppm，結果應與案例 1 完全相同
 */
describe('案例 4：當沖逾減半期限 2028-01-05', () => {
  const cost = calcRoundTripCost({
    entryPrice: '100.00',
    exitPrice: '105.00',
    shares: 1000,
    tradeType: 'day_trade',
    broker: BROKER_60,
    tradeDate: '2028-01-05',
  });

  it('自動退回一般稅率', () => {
    expect(cost.taxRatePpm).toBe(3000);
    expect(cost.tax.twd).toBe('315.00');
    expect(cost.netPnl.twd).toBe('4511.00');
  });

  it('發出逾期 warning', () => {
    expect(cost.warnings).toHaveLength(2);
    expect(cost.warnings[1]).toContain('2027-12-31');
  });

  it('稅額函式獨立驗證亦一致', () => {
    const r = calcSecuritiesTransactionTax('105.00', 1000, 'day_trade', '2028-01-05', BROKER_60);
    expect(r.ratePpm).toBe(3000);
    expect(r.tax.twd).toBe('315.00');
  });
});

/**
 * 案例 5 — 損益兩平價
 * 進場 100.00 × 1000 股，一般交易
 *
 * 買進手續費 = 85，需回收 100,000 + 85 = 100,085
 * 試 100.47：賣出金額 100,470
 *            手續費 100,470 × 0.000855 = 85.90185 → 85
 *            證交稅 100,470 × 0.003    = 301.41   → 301
 *            淨額 100,470 − 85 − 301 = 100,084 < 100,085  → 淨損益 −1  ✗
 * 試 100.48：賣出金額 100,480
 *            手續費 100,480 × 0.000855 = 85.9104  → 85
 *            證交稅 100,480 × 0.003    = 301.44   → 301
 *            淨額 100,480 − 85 − 301 = 100,094 ≥ 100,085  → 淨損益 +9  ✓
 * ⇒ 損益兩平價 = 100.48，需上漲 0.48/100.00 = 48 bps
 */
describe('案例 5：損益兩平價 100.00 × 1000 股', () => {
  const be = calcBreakevenPrice({
    entryPrice: '100.00',
    shares: 1000,
    tradeType: 'normal',
    broker: BROKER_60,
    tradeDate: TRADE_DATE,
  });

  it('取到最低的損益兩平價', () => {
    expect(be.breakevenPrice.twd).toBe('100.48');
    expect(be.breakevenMoveBps).toBe(48);
    expect(be.costAtBreakeven.netPnl.twd).toBe('9.00');
    expect(be.tickAligned).toBe(false);
  });

  it('低一分即為負，證明取到的是最小值', () => {
    const oneCentLower = calcRoundTripCost({
      entryPrice: '100.00',
      exitPrice: '100.47',
      shares: 1000,
      tradeType: 'normal',
      broker: BROKER_60,
      tradeDate: TRADE_DATE,
    });
    expect(oneCentLower.netPnl.twd).toBe('-1.00');
  });
});

/**
 * 案例 6 — 三屏障 R 倍數
 * 進場 100.00 × 1000 股，停損 95.00，停利 110.00（名目 2R），一般交易
 *
 * 名目 1R = (100 − 95) × 1000 = 5,000
 *
 * 停損觸發：賣出金額 95,000
 *           手續費 95,000 × 0.000855 = 81.225 → 81
 *           證交稅 95,000 × 0.003    = 285.0  → 285
 *           總成本 85 + 81 + 285 = 451
 *           毛損益 −5,000；淨損益 −5,451  ⇒ 淨 1R = 5,451
 *           rMultiple            = −5,451 ÷ 5,000 = −1.0902
 *           rMultipleVsNetRisk   = −5,451 ÷ 5,451 = −1
 *
 * 停利觸發：賣出金額 110,000
 *           手續費 110,000 × 0.000855 = 94.05 → 94
 *           證交稅 110,000 × 0.003    = 330.0 → 330
 *           總成本 85 + 94 + 330 = 509
 *           毛損益 +10,000；淨損益 +9,491
 *           rMultiple            = 9,491 ÷ 5,000 = 1.8982   ← 名目 2R 實際只有 1.8982R
 *           rMultipleVsNetRisk   = 9,491 ÷ 5,451 = 1.741148
 */
describe('案例 6：三屏障 R 倍數 100.00 / 停損 95.00 / 停利 110.00 × 1000 股', () => {
  const outcome = calcTradeOutcome({
    entryPrice: '100.00',
    stopLossPrice: '95.00',
    takeProfitPrice: '110.00',
    shares: 1000,
    tradeType: 'normal',
    broker: BROKER_60,
    tradeDate: TRADE_DATE,
  });

  it('名目風險與淨風險符合手算', () => {
    expect(outcome.nominalRisk.twd).toBe('5000.00');
    expect(outcome.netRisk.twd).toBe('5451.00');
  });

  it('停損側符合手算', () => {
    expect(outcome.stopLoss.cost.totalCost.twd).toBe('451.00');
    expect(outcome.stopLoss.netPnl.twd).toBe('-5451.00');
    expect(outcome.stopLoss.rMultiple).toBe(-1.0902);
    expect(outcome.stopLoss.rMultipleVsNetRisk).toBe(-1);
  });

  it('停利側符合手算', () => {
    expect(outcome.takeProfit.cost.totalCost.twd).toBe('509.00');
    expect(outcome.takeProfit.netPnl.twd).toBe('9491.00');
    expect(outcome.takeProfit.rMultiple).toBe(1.8982);
    expect(outcome.takeProfit.rMultipleVsNetRisk).toBe(1.741148);
  });

  it('名目 2R 扣成本後不足 2R，發出 warning', () => {
    expect(outcome.takeProfit.rMultiple).toBeLessThan(2);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain('< 2R');
  });

  it('同時附帶損益兩平價', () => {
    expect(outcome.breakeven.breakevenPrice.twd).toBe('100.48');
  });

  it('拒絕方向錯誤的屏障', () => {
    expect(() =>
      calcTradeOutcome({
        entryPrice: '100.00',
        stopLossPrice: '105.00',
        takeProfitPrice: '110.00',
        shares: 1000,
        tradeType: 'normal',
        broker: BROKER_60,
        tradeDate: TRADE_DATE,
      }),
    ).toThrow(RangeError);
  });
});

/**
 * 案例 7 — 溢位邊界：中間值超過 Number.MAX_SAFE_INTEGER
 * 進場 499.99 × 20,001 股，折讓 6537 bps（刻意用奇數放大失真）
 *
 * 成交金額（分）= 49,999 × 20,001                   = 1,000,029,999
 * 分子 = 1,000,029,999 × 1,425 × 6,537             = 9,315,504,447,434,775
 *        > Number.MAX_SAFE_INTEGER (9,007,199,254,740,991)
 * 分母 = 1e6 × 1e4 × 100                           = 1e12
 * 手續費 = floor(9,315,504,447,434,775 ÷ 1e12)     = 9,315
 */
describe('案例 7：溢位邊界（中間值 > MAX_SAFE_INTEGER）', () => {
  const ODD_BROKER: BrokerFeeConfig = { ...BROKER_60, discountBps: 6537 };

  it('浮點數在此量級已失真，bigint 仍精確', () => {
    const exact = 1_000_029_999n * 1425n * 6537n;
    expect(exact).toBe(9_315_504_447_434_775n);
    expect(exact > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    // 同一算式走 number 路徑得到不同的值
    expect(BigInt(1_000_029_999 * 1425 * 6537)).not.toBe(exact);
  });

  it('手續費結果與手算一致', () => {
    const fee = calcCommission('499.99', 20_001, ODD_BROKER, 'normal');
    expect(fee.fee.twd).toBe('9315.00');
    expect(fee.hitFloor).toBe(false);
  });
});
