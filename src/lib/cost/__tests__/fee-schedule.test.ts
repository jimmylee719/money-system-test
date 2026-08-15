import { describe, expect, it } from 'vitest';
import {
  COMMISSION_RATE_CAP_PPM,
  DAY_TRADE_HALVING_END,
  DAY_TRADE_HALVING_START,
  TAX_RATE_DAY_TRADE_PPM,
  TAX_RATE_STOCK_PPM,
  assertValidBrokerConfig,
  assertValidTradeDate,
  resolveSellTaxRatePpm,
} from '../fee-schedule';
import type { BrokerFeeConfig } from '../types';

const BASE: BrokerFeeConfig = {
  commissionRatePpm: 1425,
  discountBps: 6000,
  minCommissionTwd: 20,
  commissionRounding: 'floor',
  taxRounding: 'floor',
};

describe('statutory constants', () => {
  it('matches the cited legal sources', () => {
    // 證券交易稅條例 §2 第1款：千分之三
    expect(TAX_RATE_STOCK_PPM).toBe(3000);
    // 證券交易稅條例 §2-2：千分之一點五
    expect(TAX_RATE_DAY_TRADE_PPM).toBe(1500);
    // TWSE 民國97/2/1 公告：手續費上限 1.425‰
    expect(COMMISSION_RATE_CAP_PPM).toBe(1425);
    expect(DAY_TRADE_HALVING_START).toBe('2017-04-28');
    expect(DAY_TRADE_HALVING_END).toBe('2027-12-31');
  });
});

describe('assertValidTradeDate', () => {
  it('accepts real calendar dates', () => {
    expect(() => assertValidTradeDate('2026-08-14')).not.toThrow();
    expect(() => assertValidTradeDate('2024-02-29')).not.toThrow(); // 閏年
  });

  it('rejects malformed or impossible dates', () => {
    expect(() => assertValidTradeDate('2026-8-14')).toThrow(RangeError);
    expect(() => assertValidTradeDate('2026-13-01')).toThrow(RangeError);
    expect(() => assertValidTradeDate('2026-02-30')).toThrow(RangeError);
    expect(() => assertValidTradeDate('2025-02-29')).toThrow(RangeError); // 非閏年
  });
});

describe('resolveSellTaxRatePpm', () => {
  it('uses 3000 ppm for normal trades with no warnings', () => {
    const r = resolveSellTaxRatePpm('normal', '2026-08-14');
    expect(r.ratePpm).toBe(3000);
    expect(r.warnings).toHaveLength(0);
  });

  it('uses 1500 ppm inside the day-trade halving window, always warning', () => {
    const r = resolveSellTaxRatePpm('day_trade', '2026-08-14');
    expect(r.ratePpm).toBe(1500);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('禁止當沖');
  });

  it('falls back to 3000 ppm after the sunset date', () => {
    const r = resolveSellTaxRatePpm('day_trade', '2028-01-05');
    expect(r.ratePpm).toBe(3000);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[1]).toContain('2027-12-31');
  });

  it('falls back to 3000 ppm before the start date', () => {
    const r = resolveSellTaxRatePpm('day_trade', '2017-04-27');
    expect(r.ratePpm).toBe(3000);
    expect(r.warnings).toHaveLength(2);
  });

  it('accepts the exact boundary dates', () => {
    expect(resolveSellTaxRatePpm('day_trade', '2017-04-28').ratePpm).toBe(1500);
    expect(resolveSellTaxRatePpm('day_trade', '2027-12-31').ratePpm).toBe(1500);
  });
});

describe('assertValidBrokerConfig', () => {
  it('accepts a valid config', () => {
    expect(() => assertValidBrokerConfig(BASE)).not.toThrow();
  });

  it('rejects a commission rate above the statutory cap', () => {
    expect(() => assertValidBrokerConfig({ ...BASE, commissionRatePpm: 1426 })).toThrow(
      RangeError,
    );
  });

  it('rejects out-of-range discount and non-integer inputs', () => {
    expect(() => assertValidBrokerConfig({ ...BASE, discountBps: 10_001 })).toThrow(RangeError);
    expect(() => assertValidBrokerConfig({ ...BASE, discountBps: 60.5 })).toThrow(RangeError);
    expect(() => assertValidBrokerConfig({ ...BASE, minCommissionTwd: -1 })).toThrow(RangeError);
  });
});
