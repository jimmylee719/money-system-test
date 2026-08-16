import { describe, expect, it } from 'vitest';
import { computeBarriers } from '../barriers';
import { RISK_CONFIG_V1, validateRiskConfig } from '../config';
import { sizePosition } from '../sizing';

const BROKER = RISK_CONFIG_V1.broker;
const TRADE_DATE = '2026-08-17';

function size(entryPrice: number, sigmaDaily: number, equityTwd = 1_000_000, maxSinglePct = 20) {
  return sizePosition({
    barrier: computeBarriers({
      entryPrice,
      sigmaDaily,
      holdingDays: RISK_CONFIG_V1.holdingDays,
      stopSigmaMultiple: RISK_CONFIG_V1.stopSigmaMultiple,
      takeProfitR: RISK_CONFIG_V1.takeProfitR,
    }),
    equityTwd,
    riskPerTradePct: RISK_CONFIG_V1.riskPerTradePct,
    lotSize: RISK_CONFIG_V1.lotSize,
    maxSinglePositionPct: maxSinglePct,
    broker: BROKER,
    tradeDate: TRADE_DATE,
  });
}

describe('部位大小', () => {
  it('手算驗證：100 萬 × 1% ÷ 每股風險 12.6491 = 790 股 → 不足 1 張，拒絕', () => {
    // 進場 100、σ=2% → 每股風險 12.6491
    // 風險預算 10,000 ÷ 12.6491 = 790.6 股 = 0 張
    const r = size(100, 0.02);
    expect(r.position).toBeNull();
    expect(r.rejectReason).toBe('below_one_lot');
    expect(r.detail).toContain('不足 1 張');
  });

  it('低價低波動股才買得到整張：進場 20、σ=1%', () => {
    // 每股風險 = 20 × 2 × 0.01 × √10 = 1.2649
    // 10,000 ÷ 1.2649 = 7,905 股 → 7 張
    const r = size(20, 0.01);
    expect(r.position).not.toBeNull();
    expect(r.position!.lots).toBe(7);
    expect(r.position!.shares).toBe(7000);
    // 部位金額 = 7000 × 20 = 140,000 → 14%
    expect(r.position!.positionValueTwd).toBeCloseTo(140_000, 6);
    expect(r.position!.positionPct).toBeCloseTo(14, 6);
  });

  it('名目風險不得超過風險預算（無條件捨去到整張，只會更小）', () => {
    const r = size(20, 0.01);
    const budget = (1_000_000 * RISK_CONFIG_V1.riskPerTradePct) / 100;
    expect(r.position!.riskAmountTwd).toBeLessThanOrEqual(budget);
  });

  it('不足 1 張時拒絕，不會湊成 1 張（湊了就不是硬上限）', () => {
    const r = size(500, 0.03);
    expect(r.position).toBeNull();
    expect(r.rejectReason).toBe('below_one_lot');
  });

  it('低波動股會算出極大張數，被單一部位上限擋下', () => {
    // 進場 20、σ=0.2% → 每股風險 0.253，10,000 ÷ 0.253 = 39,528 股 = 39 張
    // 部位 = 39,000 × 20 = 780,000 = 78%，遠超 20% 上限
    const r = size(20, 0.002);
    expect(r.position).toBeNull();
    expect(r.rejectReason).toBe('exceeds_single_position_cap');
    expect(r.detail).toContain('78');
  });

  it('資金變大張數跟著變大，但因整張捨去而非嚴格成正比', () => {
    // 100 萬：10,000 ÷ 1.2649 = 7,905.7 股 → 7 張（捨去 0.9 張）
    // 300 萬：30,000 ÷ 1.2649 = 23,717.1 股 → 23 張（捨去 0.7 張）
    // 23 ≠ 21 —— 捨去的比例每次不同，所以資金三倍不等於張數剛好三倍。
    // 這是「只買整張」的必然結果，不是錯誤；實際風險只會比預算小，不會更大。
    const small = size(20, 0.01, 1_000_000, 100);
    const big = size(20, 0.01, 3_000_000, 100);
    expect(small.position!.lots).toBe(7);
    expect(big.position!.lots).toBe(23);
    expect(big.position!.lots).toBeGreaterThanOrEqual(small.position!.lots * 3);

    // 兩者的名目風險都必須在各自的預算之內
    expect(small.position!.riskAmountTwd).toBeLessThanOrEqual(10_000);
    expect(big.position!.riskAmountTwd).toBeLessThanOrEqual(30_000);
  });

  it('停利價的淨損益必須為正，且回報扣成本後的真實 R', () => {
    const r = size(20, 0.01);
    expect(r.position!.outcome.takeProfit.netPnl.cents).toBeGreaterThan(0n);
    // 名目 2R，扣掉手續費與證交稅後必然小於 2
    expect(r.position!.outcome.takeProfit.rMultiple).toBeLessThan(2);
    expect(r.position!.outcome.takeProfit.rMultiple).toBeGreaterThan(1.5);
  });

  it('停損觸發時的實際虧損比名目 1R 更大（成本讓虧損那端變糟）', () => {
    const r = size(20, 0.01);
    expect(r.position!.outcome.stopLoss.rMultiple).toBeLessThan(-1);
  });
});

describe('風控設定的健全性', () => {
  it('v1 設定本身通過檢查', () => {
    expect(validateRiskConfig(RISK_CONFIG_V1)).toEqual([]);
  });

  it('r 超出 CLAUDE.md 的 1%–2% 會被擋', () => {
    expect(validateRiskConfig({ ...RISK_CONFIG_V1, riskPerTradePct: 5 })[0]).toContain('1%–2%');
  });

  it('停利低於 2R 會被擋', () => {
    expect(validateRiskConfig({ ...RISK_CONFIG_V1, takeProfitR: 1.5 })[0]).toContain('≥2R');
  });

  it('熔斷門檻若低於「同時全部停損」的損失，會被擋 —— 否則熔斷正常情況就觸發', () => {
    const issues = validateRiskConfig({ ...RISK_CONFIG_V1, circuitBreakerDrawdownPct: 4 });
    expect(issues.join()).toContain('熔斷會在正常情況下就觸發');
  });

  it('v1 的最壞同時損失（5 檔 × 1% = 5%）確實低於熔斷門檻 15%', () => {
    const worst = RISK_CONFIG_V1.maxConcurrentPositions * RISK_CONFIG_V1.riskPerTradePct;
    expect(worst).toBe(5);
    expect(worst).toBeLessThan(RISK_CONFIG_V1.circuitBreakerDrawdownPct);
  });
});
