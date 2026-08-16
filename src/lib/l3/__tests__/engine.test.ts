import { describe, expect, it } from 'vitest';
import type { RankedStock } from '../../l1/factors/engine';
import { ACTIVE_RISK_CONFIG } from '../config';
import type { RiskConfig } from '../config';
import { RiskLayerViolationError, applyRiskLimits, assertOnlySubtracts } from '../engine';
import type { RiskContext } from '../engine';
import type { DailyVolatility } from '../volatility';

const DAY = '2026-08-17';

function stock(code: string, close: number): RankedStock {
  return {
    code,
    market: 'TWSE',
    name: `公司${code}`,
    close,
    compositeScore: 0.9,
    realFactorCount: 3,
    factorScores: [],
  };
}

function vol(sigma: number | null, reason: string | null = null): DailyVolatility {
  return { sigmaDaily: sigma, observations: sigma === null ? 1 : 25, reason };
}

function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    signalDate: DAY,
    volatilityByCode: new Map(),
    entriesThisMonth: 0,
    openPositions: 0,
    currentExposurePct: 0,
    drawdownPct: 0,
    ...over,
  };
}

/**
 * 可交易的錨點：進場 50、σ=2%、risk-v2（資金 1 萬、r=2%、零股）
 * → 每股風險 6.3246、24 股、部位 1,200 元（12.0%）
 */
const TRADEABLE_SIGMA = 0.02;
const TRADEABLE_PRICE = 50;
const TRADEABLE_POSITION_PCT = 12;

function tradeable(...codes: string[]): { stocks: RankedStock[]; vols: Map<string, DailyVolatility> } {
  const stocks = codes.map((c) => stock(c, TRADEABLE_PRICE));
  const vols = new Map(codes.map((c) => [c, vol(TRADEABLE_SIGMA)]));
  return { stocks, vols };
}

describe('L3 只能減少行動（硬上限）', () => {
  it('核准 + 被拒的相異代號 = 輸入，沒有標的憑空消失或出現', () => {
    const { stocks, vols } = tradeable('1101', '1102', '1103');
    const result = applyRiskLimits(stocks, ctx({ volatilityByCode: vols }), ACTIVE_RISK_CONFIG);
    const rejectedCodes = new Set(result.rejected.map((r) => r.code));
    expect(result.approved.length + rejectedCodes.size).toBe(stocks.length);
  });

  it('核准清單裡不可能出現輸入以外的標的', () => {
    expect(() =>
      assertOnlySubtracts([stock('1101', 20)], {
        approved: [
          {
            stock: stock('9999', 20),
            barrier: {
              entryPrice: 20,
              stopPrice: 18,
              takeProfitPrice: 24,
              timeExitDays: 10,
              riskPerShare: 2,
              stopDistancePct: 0.1,
            },
            position: {
              lots: 1,
              shares: 1000,
              positionValueTwd: 20_000,
              riskAmountTwd: 2000,
              positionPct: 2,
              outcome: {} as never,
            },
            sigmaDaily: 0.01,
            volObservations: 25,
          },
        ],
        rejected: [],
        countsByReason: {},
        haltedGlobally: false,
        haltReason: null,
      }),
    ).toThrow(RiskLayerViolationError);
  });
});

describe('全域限制：觸發即當日 0 檔，沒有例外', () => {
  it('熔斷：淨值回撤達門檻 → 全部拒絕', () => {
    const { stocks, vols } = tradeable('1101', '1102');
    const result = applyRiskLimits(
      stocks,
      ctx({ volatilityByCode: vols, drawdownPct: 15 }),
      ACTIVE_RISK_CONFIG,
    );
    expect(result.approved).toHaveLength(0);
    expect(result.haltedGlobally).toBe(true);
    expect(result.rejected.every((r) => r.reason === 'circuit_breaker')).toBe(true);
  });

  it('熔斷門檻之下正常運作（14.9% 不觸發，15% 觸發）', () => {
    const { stocks, vols } = tradeable('1101');
    expect(
      applyRiskLimits(stocks, ctx({ volatilityByCode: vols, drawdownPct: 14.9 }), ACTIVE_RISK_CONFIG)
        .haltedGlobally,
    ).toBe(false);
    expect(
      applyRiskLimits(stocks, ctx({ volatilityByCode: vols, drawdownPct: 15 }), ACTIVE_RISK_CONFIG)
        .haltedGlobally,
    ).toBe(true);
  });

  it('換手預算：當月已達上限 → 全部拒絕，不論排名多高', () => {
    const { stocks, vols } = tradeable('1101', '1102');
    const result = applyRiskLimits(
      stocks,
      ctx({ volatilityByCode: vols, entriesThisMonth: ACTIVE_RISK_CONFIG.monthlyEntryCap }),
      ACTIVE_RISK_CONFIG,
    );
    expect(result.approved).toHaveLength(0);
    expect(result.haltedGlobally).toBe(true);
    expect(result.rejected[0]!.reason).toBe('monthly_turnover_cap');
  });
});

describe('名額類限制會隨核准而消耗', () => {
  it('同時部位數上限：只核准到額滿為止', () => {
    const codes = ['1101', '1102', '1103', '1104', '1105', '1106', '1107'];
    const { stocks, vols } = tradeable(...codes);
    const config: RiskConfig = {
      ...ACTIVE_RISK_CONFIG,
      maxTotalExposurePct: 100,
      maxConcurrentPositions: 5,
    };
    const result = applyRiskLimits(
      stocks,
      ctx({ volatilityByCode: vols, openPositions: 3 }),
      config,
    );
    // 已持有 3 檔，上限 5 檔 → 只能再核准 2 檔
    expect(result.approved).toHaveLength(2);
    expect(result.countsByReason['concurrent_position_cap']).toBe(5);
  });

  it('總曝險上限：依排名順序給額度，額滿後拒絕', () => {
    // 每檔部位 12%，上限 60% → 最多 5 檔（60%），第 6 檔會超過
    const codes = ['1101', '1102', '1103', '1104', '1105', '1106'];
    const { stocks, vols } = tradeable(...codes);
    const config: RiskConfig = { ...ACTIVE_RISK_CONFIG, maxConcurrentPositions: 99 };
    const result = applyRiskLimits(stocks, ctx({ volatilityByCode: vols }), config);
    expect(result.approved).toHaveLength(5);
    expect(result.approved.map((a) => a.stock.code)).toEqual([
      '1101',
      '1102',
      '1103',
      '1104',
      '1105',
    ]);
    expect(result.rejected[0]!.reason).toBe('total_exposure_cap');
  });

  it('v2 的預設值：同時部位上限 3 檔會比曝險上限先綁住', () => {
    const codes = ['1101', '1102', '1103', '1104', '1105'];
    const { stocks, vols } = tradeable(...codes);
    const result = applyRiskLimits(stocks, ctx({ volatilityByCode: vols }), ACTIVE_RISK_CONFIG);
    expect(result.approved).toHaveLength(3);
    expect(result.countsByReason['concurrent_position_cap']).toBe(2);
  });

  it('額度先給名次高的，不是給代號小的', () => {
    // 故意讓代號順序與排名順序相反
    const stocks = [stock('9999', 20), stock('1101', 20)];
    const vols = new Map([
      ['9999', vol(TRADEABLE_SIGMA)],
      ['1101', vol(TRADEABLE_SIGMA)],
    ]);
    const config: RiskConfig = { ...ACTIVE_RISK_CONFIG, maxConcurrentPositions: 1 };
    const result = applyRiskLimits(stocks, ctx({ volatilityByCode: vols }), config);
    expect(result.approved).toHaveLength(1);
    expect(result.approved[0]!.stock.code).toBe('9999'); // 排在前面的先拿到
  });
});

describe('個股層級的拒絕', () => {
  it('波動率估不出來 → 拒絕，並保留原因', () => {
    const stocks = [stock('1101', 20)];
    const vols = new Map([['1101', vol(null, '波動率估計需要 20 筆日報酬，目前只有 1 筆')]]);
    const result = applyRiskLimits(stocks, ctx({ volatilityByCode: vols }), ACTIVE_RISK_CONFIG);
    expect(result.approved).toHaveLength(0);
    expect(result.rejected[0]!.reason).toBe('volatility_unavailable');
    expect(result.rejected[0]!.detail).toContain('需要 20 筆');
  });

  it('完全沒有這一檔的波動資料 → 也是拒絕，不是放行', () => {
    const result = applyRiskLimits(
      [stock('1101', 20)],
      ctx({ volatilityByCode: new Map() }),
      ACTIVE_RISK_CONFIG,
    );
    expect(result.rejected[0]!.reason).toBe('volatility_unavailable');
  });

  it('波動過大導致停損價為負 → barrier_infeasible', () => {
    const vols = new Map([['1101', vol(0.2)]]);
    const result = applyRiskLimits([stock('1101', 20)], ctx({ volatilityByCode: vols }), ACTIVE_RISK_CONFIG);
    expect(result.rejected[0]!.reason).toBe('barrier_infeasible');
  });

  it('零股開放後，1000 元的高價股買 1 股即可，不再被拒', () => {
    const vols = new Map([['2330', vol(0.02)]]);
    const result = applyRiskLimits(
      [stock('2330', 1000)],
      ctx({ volatilityByCode: vols }),
      ACTIVE_RISK_CONFIG,
    );
    expect(result.approved).toHaveLength(1);
    expect(result.approved[0]!.position.shares).toBe(1);
  });

  it('改回只買整張時，同一檔就變成 below_one_lot', () => {
    const vols = new Map([['2330', vol(0.02)]]);
    const config: RiskConfig = { ...ACTIVE_RISK_CONFIG, lotSize: 1000 };
    const result = applyRiskLimits([stock('2330', 1000)], ctx({ volatilityByCode: vols }), config);
    expect(result.rejected[0]!.reason).toBe('below_one_lot');
  });

  it('低波動股會被單一部位上限擋下', () => {
    const vols = new Map([['1101', vol(0.002)]]);
    const result = applyRiskLimits(
      [stock('1101', 20)],
      ctx({ volatilityByCode: vols }),
      ACTIVE_RISK_CONFIG,
    );
    expect(result.rejected[0]!.reason).toBe('exceeds_single_position_cap');
  });

  it('被拒絕的標的不影響後面的標的取得額度', () => {
    const stocks = [stock('1101', 20), stock('1102', TRADEABLE_PRICE)]; // 第一檔會被部位上限擋
    const vols = new Map([
      ['1101', vol(0.002)],
      ['1102', vol(TRADEABLE_SIGMA)],
    ]);
    const result = applyRiskLimits(stocks, ctx({ volatilityByCode: vols }), ACTIVE_RISK_CONFIG);
    expect(result.approved).toHaveLength(1);
    expect(result.approved[0]!.stock.code).toBe('1102');
  });
});

describe('每日買進金額上限（只會讓買進變少）', () => {
  it('預設不設限', () => {
    expect(ACTIVE_RISK_CONFIG.dailyBuyBudgetTwd).toBeNull();
  });

  it('設定後，超出當日剩餘預算的部位被拒絕', () => {
    // 每檔部位 1,200 元；預算 2,500 元 → 只能買 2 檔
    const codes = ['1101', '1102', '1103'];
    const { stocks, vols } = tradeable(...codes);
    const config: RiskConfig = {
      ...ACTIVE_RISK_CONFIG,
      dailyBuyBudgetTwd: 2500,
      maxConcurrentPositions: 99,
    };
    const result = applyRiskLimits(stocks, ctx({ volatilityByCode: vols }), config);
    expect(result.approved).toHaveLength(2);
    expect(result.rejected[0]!.reason).toBe('daily_buy_budget');
    expect(result.rejected[0]!.detail).toContain('不縮小部位去湊預算');
  });

  it('不會為了用完預算而縮小部位 —— 縮了實際風險就不等於設定的 r', () => {
    const { stocks, vols } = tradeable('1101');
    const config: RiskConfig = { ...ACTIVE_RISK_CONFIG, dailyBuyBudgetTwd: 1000 };
    const result = applyRiskLimits(stocks, ctx({ volatilityByCode: vols }), config);
    // 部位需 1,200 元 > 預算 1,000 元 → 整筆跳過，不是買 1,000 元
    expect(result.approved).toHaveLength(0);
    expect(result.rejected[0]!.reason).toBe('daily_buy_budget');
  });

  it('預算夠時完全不影響', () => {
    const { stocks, vols } = tradeable('1101');
    const config: RiskConfig = { ...ACTIVE_RISK_CONFIG, dailyBuyBudgetTwd: 100_000 };
    const result = applyRiskLimits(stocks, ctx({ volatilityByCode: vols }), config);
    expect(result.approved).toHaveLength(1);
  });
});

describe('核准的訊號帶有完整屏障與部位', () => {
  it('三道屏障與張數同時寫死，進場前就決定', () => {
    const { stocks, vols } = tradeable('1101');
    const result = applyRiskLimits(stocks, ctx({ volatilityByCode: vols }), ACTIVE_RISK_CONFIG);
    const signal = result.approved[0]!;

    expect(signal.barrier.entryPrice).toBe(TRADEABLE_PRICE);
    expect(signal.barrier.stopPrice).toBeLessThan(TRADEABLE_PRICE);
    expect(signal.barrier.takeProfitPrice).toBeGreaterThan(TRADEABLE_PRICE);
    expect(signal.barrier.timeExitDays).toBe(ACTIVE_RISK_CONFIG.holdingDays);
    expect(signal.position.shares).toBe(24);
    expect(signal.position.positionPct).toBeCloseTo(TRADEABLE_POSITION_PCT, 6);
    expect(signal.sigmaDaily).toBe(TRADEABLE_SIGMA);
    expect(signal.volObservations).toBe(25);

    // r 是硬上限：停損時的實際虧損（含成本）不得超過 資金 × r
    const budget = (ACTIVE_RISK_CONFIG.equityTwd * ACTIVE_RISK_CONFIG.riskPerTradePct) / 100;
    expect(-Number(signal.position.outcome.stopLoss.netPnl.twd)).toBeLessThanOrEqual(budget);

    // 停利距離必須恰為停損距離的 takeProfitR 倍
    const r = signal.barrier.entryPrice - signal.barrier.stopPrice;
    expect(signal.barrier.takeProfitPrice - signal.barrier.entryPrice).toBeCloseTo(
      ACTIVE_RISK_CONFIG.takeProfitR * r,
      10,
    );
  });
});
