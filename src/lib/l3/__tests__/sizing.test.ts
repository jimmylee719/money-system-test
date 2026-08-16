import { describe, expect, it } from 'vitest';
import { computeBarriers } from '../barriers';
import { ACTIVE_RISK_CONFIG, RISK_CONFIG_V1, RISK_CONFIG_V2, validateRiskConfig } from '../config';
import type { RiskConfig } from '../config';
import { sizePosition } from '../sizing';

const C = ACTIVE_RISK_CONFIG;
const TRADE_DATE = '2026-08-17';

function size(
  entryPrice: number,
  sigmaDaily: number,
  over: Partial<Pick<RiskConfig, 'equityTwd' | 'maxSinglePositionPct' | 'lotSize' | 'riskPerTradePct'>> = {},
) {
  const cfg = { ...C, ...over };
  return sizePosition({
    barrier: computeBarriers({
      entryPrice,
      sigmaDaily,
      holdingDays: cfg.holdingDays,
      stopSigmaMultiple: cfg.stopSigmaMultiple,
      takeProfitR: cfg.takeProfitR,
    }),
    equityTwd: cfg.equityTwd,
    riskPerTradePct: cfg.riskPerTradePct,
    lotSize: cfg.lotSize,
    maxSinglePositionPct: cfg.maxSinglePositionPct,
    broker: cfg.broker,
    tradeDate: TRADE_DATE,
  });
}

/** 實際虧損（正數） */
function actualLoss(r: ReturnType<typeof size>): number {
  return -Number(r.position!.outcome.stopLoss.netPnl.twd);
}
function actualWin(r: ReturnType<typeof size>): number {
  return Number(r.position!.outcome.takeProfit.netPnl.twd);
}

describe('r 是真正的硬上限：實際虧損含成本後仍不超過預算', () => {
  // 這是 2026-08-16 修正的核心。v1 只用名目風險反解股數，
  // 停損時的實際虧損（名目 + 來回成本）每次都會超出預算。
  const cases: readonly { entry: number; sigma: number; equity: number }[] = [
    { entry: 50, sigma: 0.02, equity: 10_000 },
    { entry: 100, sigma: 0.02, equity: 10_000 },
    { entry: 1000, sigma: 0.02, equity: 10_000 },
    { entry: 500, sigma: 0.03, equity: 10_000 },
    { entry: 50, sigma: 0.02, equity: 30_000 },
    { entry: 50, sigma: 0.02, equity: 100_000 },
    { entry: 33.5, sigma: 0.017, equity: 20_000 },
  ];

  for (const { entry, sigma, equity } of cases) {
    it(`進場 ${entry}、σ=${(sigma * 100).toFixed(1)}%、資金 ${equity.toLocaleString()}`, () => {
      const r = size(entry, sigma, { equityTwd: equity, maxSinglePositionPct: 100 });
      expect(r.position, r.detail).not.toBeNull();
      const budget = (equity * C.riskPerTradePct) / 100;
      expect(actualLoss(r)).toBeLessThanOrEqual(budget);
    });
  }

  it('若把成本忽略掉，實際虧損就會超出預算（證明這個修正是必要的）', () => {
    // 用 v1 的做法反解：不計成本
    const barrier = computeBarriers({
      entryPrice: 50,
      sigmaDaily: 0.02,
      holdingDays: C.holdingDays,
      stopSigmaMultiple: C.stopSigmaMultiple,
      takeProfitR: C.takeProfitR,
    });
    const budget = 200;
    const naiveShares = Math.floor(budget / barrier.riskPerShare); // 31 股
    const correct = size(50, 0.02, { maxSinglePositionPct: 100 });
    // 正確解必定比不計成本的解更小
    expect(correct.position!.shares).toBeLessThan(naiveShares);
    // 而且正確解的實際虧損在預算內
    expect(actualLoss(correct)).toBeLessThanOrEqual(budget);
  });
});

describe('零股：高價股也買得到', () => {
  it('進場 1000 元的股票買 1 股，不再是「買不起」', () => {
    const r = size(1000, 0.02);
    expect(r.position).not.toBeNull();
    expect(r.position!.shares).toBe(1);
    expect(r.position!.positionValueTwd).toBe(1000);
  });

  it('lotSize=1000（只買整張）時，同一檔就變成買不起', () => {
    const r = size(1000, 0.02, { lotSize: 1000 });
    expect(r.position).toBeNull();
    expect(r.rejectReason).toBe('below_one_lot');
  });

  it('手算錨點：進場 50、σ=2%、資金 1 萬 → 24 股', () => {
    // 每股風險 = 50 × 2 × 0.02 × √10 = 6.3246
    // 不計成本：200 ÷ 6.3246 = 31.6 股；計入來回成本後收斂到 24 股
    const r = size(50, 0.02);
    expect(r.position!.shares).toBe(24);
    expect(r.position!.positionValueTwd).toBe(1200);
    expect(actualLoss(r)).toBeLessThanOrEqual(200);
  });
});

describe('賠率必須大於 1:1', () => {
  it('部位太小導致賠率低於 1:1 → 拒絕', () => {
    // 資金 5,000 → 部位僅數百元 → 買賣各 20 元的最低手續費吃光 2:1 的優勢
    const r = size(50, 0.02, { equityTwd: 5000 });
    expect(r.position).toBeNull();
    expect(r.rejectReason).toBe('odds_below_one');
    expect(r.detail).toContain('低於 1 : 1');
  });

  it('資金再小一點連損益兩平都到不了，會先被 target_below_breakeven 擋下', () => {
    const r = size(50, 0.02, { equityTwd: 3000 });
    expect(r.position).toBeNull();
    expect(r.rejectReason).toBe('target_below_breakeven');
  });

  it('實測門檻：進場 50、σ=2% 時，資金約 7,000 元以上才過得了賠率檢查', () => {
    // 這個數字是實跑出來的，不是訂出來的門檻——
    // 它會隨股價與波動而變，所以不寫進設定，由規則自然決定。
    expect(size(50, 0.02, { equityTwd: 6000 }).rejectReason).toBe('odds_below_one');
    expect(size(50, 0.02, { equityTwd: 7000 }).position).not.toBeNull();
  });

  it('通過的部位，實得必定大於實虧', () => {
    for (const equity of [10_000, 30_000, 100_000]) {
      const r = size(50, 0.02, { equityTwd: equity, maxSinglePositionPct: 100 });
      expect(actualWin(r), `資金 ${equity}`).toBeGreaterThan(actualLoss(r));
    }
  });

  it('資金越大賠率越好（固定手續費的稀釋效應遞減）', () => {
    const odds = (equity: number): number => {
      const r = size(50, 0.02, { equityTwd: equity, maxSinglePositionPct: 100 });
      return actualWin(r) / actualLoss(r);
    };
    expect(odds(10_000)).toBeLessThan(odds(30_000));
    expect(odds(30_000)).toBeLessThan(odds(100_000));
    // 名目賠率是 2:1，扣成本後永遠達不到
    expect(odds(100_000)).toBeLessThan(2);
  });
});

describe('單一部位上限', () => {
  it('低波動股的停損距離短，會算出極大部位並被上限擋下', () => {
    const r = size(20, 0.002);
    expect(r.position).toBeNull();
    expect(r.rejectReason).toBe('exceeds_single_position_cap');
    // 零股模式下訊息不該出現「張」
    expect(r.detail).toContain('股');
    expect(r.detail).not.toContain('張');
  });
});

describe('風控設定的健全性', () => {
  it('v1 與 v2 本身都通過檢查', () => {
    expect(validateRiskConfig(RISK_CONFIG_V1)).toEqual([]);
    expect(validateRiskConfig(RISK_CONFIG_V2)).toEqual([]);
  });

  it('目前生效的是 v2', () => {
    expect(ACTIVE_RISK_CONFIG.version).toBe('risk-v2');
    expect(ACTIVE_RISK_CONFIG.lotSize).toBe(1); // 允許零股
  });

  it('r 超出 CLAUDE.md 的 1%–2% 會被擋', () => {
    expect(validateRiskConfig({ ...C, riskPerTradePct: 5 })[0]).toContain('1%–2%');
  });

  it('停利低於 2R 會被擋', () => {
    expect(validateRiskConfig({ ...C, takeProfitR: 1.5 })[0]).toContain('≥2R');
  });

  it('熔斷門檻若低於「同時全部停損」的損失，會被擋', () => {
    expect(validateRiskConfig({ ...C, circuitBreakerDrawdownPct: 5 }).join()).toContain(
      '熔斷會在正常情況下就觸發',
    );
  });

  it('v2 的最壞同時損失（3 檔 × 2% = 6%）仍明顯低於熔斷門檻 15%', () => {
    const worst = C.maxConcurrentPositions * C.riskPerTradePct;
    expect(worst).toBe(6);
    expect(worst * 2).toBeLessThan(C.circuitBreakerDrawdownPct);
  });

  it('每日買進上限若有設定必須為正數', () => {
    expect(validateRiskConfig({ ...C, dailyBuyBudgetTwd: 0 })[0]).toContain('dailyBuyBudgetTwd');
    expect(validateRiskConfig({ ...C, dailyBuyBudgetTwd: 5000 })).toEqual([]);
    expect(validateRiskConfig({ ...C, dailyBuyBudgetTwd: null })).toEqual([]);
  });
});
