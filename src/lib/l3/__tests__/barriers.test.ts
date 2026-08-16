import { describe, expect, it } from 'vitest';
import { BarrierError, computeBarriers } from '../barriers';

const BASE = {
  entryPrice: 100,
  sigmaDaily: 0.02, // 日波動 2%
  holdingDays: 10,
  stopSigmaMultiple: 2,
  takeProfitR: 2,
};

describe('三屏障', () => {
  it('手算驗證：σ=2%、N=10、2σ → 停損距離 = 2×0.02×√10 = 12.649%', () => {
    const b = computeBarriers(BASE);
    const expectedPct = 2 * 0.02 * Math.sqrt(10);
    expect(b.stopDistancePct).toBeCloseTo(expectedPct, 12);
    expect(b.stopDistancePct).toBeCloseTo(0.1264911064, 9);

    // 進場 100 → 停損 87.3509、1R = 12.6491
    expect(b.riskPerShare).toBeCloseTo(12.6491106, 6);
    expect(b.stopPrice).toBeCloseTo(87.3508894, 6);
    // 停利 = 進場 + 2R = 100 + 25.2982 = 125.2982
    expect(b.takeProfitPrice).toBeCloseTo(125.2982213, 6);
    expect(b.timeExitDays).toBe(10);
  });

  it('停利恰為 takeProfitR 個 R，不是固定百分比', () => {
    const b = computeBarriers(BASE);
    const r = b.entryPrice - b.stopPrice;
    expect(b.takeProfitPrice - b.entryPrice).toBeCloseTo(2 * r, 10);
  });

  it('高波動股的停損自動放寬，低波動股自動收緊（這就是不用固定百分比的意義）', () => {
    const calm = computeBarriers({ ...BASE, sigmaDaily: 0.01 });
    const wild = computeBarriers({ ...BASE, sigmaDaily: 0.04 });
    expect(wild.stopDistancePct).toBeCloseTo(calm.stopDistancePct * 4, 10);
    // 同樣的進場價，波動大的停損價比較低
    expect(wild.stopPrice).toBeLessThan(calm.stopPrice);
  });

  it('屏障隨持有期間以 √N 放大，不是線性', () => {
    const short = computeBarriers({ ...BASE, holdingDays: 5 });
    const long = computeBarriers({ ...BASE, holdingDays: 20 });
    // N 從 5 變 20（4 倍），距離應為 2 倍而非 4 倍
    expect(long.stopDistancePct / short.stopDistancePct).toBeCloseTo(2, 10);
  });

  it('波動率為 0 或負數時拋錯 —— 估不出來應該拒絕出訊號，不是傳 0 進來', () => {
    expect(() => computeBarriers({ ...BASE, sigmaDaily: 0 })).toThrow(BarrierError);
    expect(() => computeBarriers({ ...BASE, sigmaDaily: -0.01 })).toThrow('日波動率必須為正數');
  });

  it('停損距離超過 100% 時拋錯，不會產生負的停損價', () => {
    // σ=20%、N=10、2σ → 距離 126%，停損價會是 -26 元
    expect(() => computeBarriers({ ...BASE, sigmaDaily: 0.2 })).toThrow(/超過 100%/);
  });

  it('進場價非正數時拋錯', () => {
    expect(() => computeBarriers({ ...BASE, entryPrice: 0 })).toThrow('進場價必須為正數');
  });
});
