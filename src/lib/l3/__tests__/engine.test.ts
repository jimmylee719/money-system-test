import { describe, expect, it } from 'vitest';
import type { RankedStock } from '../../l1/factors/engine';
import { RISK_CONFIG_V1 } from '../config';
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

/** 進場 20、σ=1% → 每股風險 1.2649，100 萬 × 1% → 7 張、部位 14% */
const TRADEABLE_SIGMA = 0.01;
const TRADEABLE_PRICE = 20;

function tradeable(...codes: string[]): { stocks: RankedStock[]; vols: Map<string, DailyVolatility> } {
  const stocks = codes.map((c) => stock(c, TRADEABLE_PRICE));
  const vols = new Map(codes.map((c) => [c, vol(TRADEABLE_SIGMA)]));
  return { stocks, vols };
}

describe('L3 只能減少行動（硬上限）', () => {
  it('核准 + 被拒的相異代號 = 輸入，沒有標的憑空消失或出現', () => {
    const { stocks, vols } = tradeable('1101', '1102', '1103');
    const result = applyRiskLimits(stocks, ctx({ volatilityByCode: vols }), RISK_CONFIG_V1);
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
      RISK_CONFIG_V1,
    );
    expect(result.approved).toHaveLength(0);
    expect(result.haltedGlobally).toBe(true);
    expect(result.rejected.every((r) => r.reason === 'circuit_breaker')).toBe(true);
  });

  it('熔斷門檻之下正常運作（14.9% 不觸發，15% 觸發）', () => {
    const { stocks, vols } = tradeable('1101');
    expect(
      applyRiskLimits(stocks, ctx({ volatilityByCode: vols, drawdownPct: 14.9 }), RISK_CONFIG_V1)
        .haltedGlobally,
    ).toBe(false);
    expect(
      applyRiskLimits(stocks, ctx({ volatilityByCode: vols, drawdownPct: 15 }), RISK_CONFIG_V1)
        .haltedGlobally,
    ).toBe(true);
  });

  it('換手預算：當月已達上限 → 全部拒絕，不論排名多高', () => {
    const { stocks, vols } = tradeable('1101', '1102');
    const result = applyRiskLimits(
      stocks,
      ctx({ volatilityByCode: vols, entriesThisMonth: RISK_CONFIG_V1.monthlyEntryCap }),
      RISK_CONFIG_V1,
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
    const config: RiskConfig = { ...RISK_CONFIG_V1, maxTotalExposurePct: 100 };
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
    // 每檔部位 14%，上限 60% → 最多 4 檔（56%），第 5 檔會超過
    const codes = ['1101', '1102', '1103', '1104', '1105'];
    const { stocks, vols } = tradeable(...codes);
    const result = applyRiskLimits(stocks, ctx({ volatilityByCode: vols }), RISK_CONFIG_V1);
    expect(result.approved).toHaveLength(4);
    expect(result.approved.map((a) => a.stock.code)).toEqual(['1101', '1102', '1103', '1104']);
    expect(result.rejected[0]!.reason).toBe('total_exposure_cap');
  });

  it('額度先給名次高的，不是給代號小的', () => {
    // 故意讓代號順序與排名順序相反
    const stocks = [stock('9999', 20), stock('1101', 20)];
    const vols = new Map([
      ['9999', vol(TRADEABLE_SIGMA)],
      ['1101', vol(TRADEABLE_SIGMA)],
    ]);
    const config: RiskConfig = { ...RISK_CONFIG_V1, maxConcurrentPositions: 1 };
    const result = applyRiskLimits(stocks, ctx({ volatilityByCode: vols }), config);
    expect(result.approved).toHaveLength(1);
    expect(result.approved[0]!.stock.code).toBe('9999'); // 排在前面的先拿到
  });
});

describe('個股層級的拒絕', () => {
  it('波動率估不出來 → 拒絕，並保留原因', () => {
    const stocks = [stock('1101', 20)];
    const vols = new Map([['1101', vol(null, '波動率估計需要 20 筆日報酬，目前只有 1 筆')]]);
    const result = applyRiskLimits(stocks, ctx({ volatilityByCode: vols }), RISK_CONFIG_V1);
    expect(result.approved).toHaveLength(0);
    expect(result.rejected[0]!.reason).toBe('volatility_unavailable');
    expect(result.rejected[0]!.detail).toContain('需要 20 筆');
  });

  it('完全沒有這一檔的波動資料 → 也是拒絕，不是放行', () => {
    const result = applyRiskLimits(
      [stock('1101', 20)],
      ctx({ volatilityByCode: new Map() }),
      RISK_CONFIG_V1,
    );
    expect(result.rejected[0]!.reason).toBe('volatility_unavailable');
  });

  it('波動過大導致停損價為負 → barrier_infeasible', () => {
    const vols = new Map([['1101', vol(0.2)]]);
    const result = applyRiskLimits([stock('1101', 20)], ctx({ volatilityByCode: vols }), RISK_CONFIG_V1);
    expect(result.rejected[0]!.reason).toBe('barrier_infeasible');
  });

  it('高價股買不到 1 張 → below_one_lot', () => {
    const vols = new Map([['2330', vol(0.02)]]);
    const result = applyRiskLimits([stock('2330', 1000)], ctx({ volatilityByCode: vols }), RISK_CONFIG_V1);
    expect(result.rejected[0]!.reason).toBe('below_one_lot');
  });

  it('被拒絕的標的不影響後面的標的取得額度', () => {
    const stocks = [stock('2330', 1000), stock('1101', 20)]; // 第一檔買不起
    const vols = new Map([
      ['2330', vol(0.02)],
      ['1101', vol(TRADEABLE_SIGMA)],
    ]);
    const result = applyRiskLimits(stocks, ctx({ volatilityByCode: vols }), RISK_CONFIG_V1);
    expect(result.approved).toHaveLength(1);
    expect(result.approved[0]!.stock.code).toBe('1101');
  });
});

describe('核准的訊號帶有完整屏障與部位', () => {
  it('三道屏障與張數同時寫死，進場前就決定', () => {
    const { stocks, vols } = tradeable('1101');
    const result = applyRiskLimits(stocks, ctx({ volatilityByCode: vols }), RISK_CONFIG_V1);
    const signal = result.approved[0]!;

    expect(signal.barrier.entryPrice).toBe(20);
    expect(signal.barrier.stopPrice).toBeLessThan(20);
    expect(signal.barrier.takeProfitPrice).toBeGreaterThan(20);
    expect(signal.barrier.timeExitDays).toBe(RISK_CONFIG_V1.holdingDays);
    expect(signal.position.lots).toBe(7);
    expect(signal.sigmaDaily).toBe(TRADEABLE_SIGMA);
    expect(signal.volObservations).toBe(25);

    // 停利距離必須恰為停損距離的 takeProfitR 倍
    const r = signal.barrier.entryPrice - signal.barrier.stopPrice;
    expect(signal.barrier.takeProfitPrice - signal.barrier.entryPrice).toBeCloseTo(
      RISK_CONFIG_V1.takeProfitR * r,
      10,
    );
  });
});
