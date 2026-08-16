import { describe, expect, it } from 'vitest';
import { estimateDailyVolatility, ewmStd, logReturns } from '../volatility';

describe('logReturns', () => {
  it('n 個價格產生 n-1 個報酬', () => {
    expect(logReturns([100, 110, 121])).toHaveLength(2);
  });

  it('對數報酬手算驗證', () => {
    const r = logReturns([100, 110]);
    expect(r[0]).toBeCloseTo(Math.log(1.1), 12);
  });

  it('非正價格不算成報酬 0，而是跳過（那是資料問題不是沒漲跌）', () => {
    expect(logReturns([100, 0, 110])).toHaveLength(0);
    expect(logReturns([100, -5])).toHaveLength(0);
  });
});

describe('ewmStd 對齊 pandas ewm(span).std()', () => {
  it('等權極限：span 極大時逼近樣本標準差', () => {
    const values = [1, 2, 3, 4, 5];
    // span → ∞ 時 alpha → 0，權重趨於相等，結果應接近樣本標準差 (ddof=1)
    const sampleStd = Math.sqrt(
      values.reduce((s, v) => s + (v - 3) ** 2, 0) / (values.length - 1),
    );
    const ewm = ewmStd(values, 1_000_000)!;
    expect(ewm).toBeCloseTo(sampleStd, 4);
  });

  it('手算驗證：[1,2,3,4] span=3 的變異數恰為 97/70', () => {
    // ⚠️ 這個數字是**手算**出來的，不是「pandas 跑出來的」。
    //    本機沒有可用的 Python，無法實跑 pandas 比對；
    //    憑記憶寫一個 pandas 輸出值就是捏造，故改為完整手算並記錄推導。
    //    P12 建 Python service 時再實跑 pandas 交叉驗證（屆時才可宣稱「與 pandas 一致」）。
    //
    // alpha = 2/(3+1) = 0.5，權重 wᵢ = 0.5^(3−i) = [0.125, 0.25, 0.5, 1]
    //   sumW        = 1.875
    //   sumW2       = 0.015625 + 0.0625 + 0.25 + 1 = 1.328125
    //   加權平均     = (0.125·1 + 0.25·2 + 0.5·3 + 1·4) / 1.875 = 6.125/1.875 = 49/15
    //   加權平方差和 = 363.75/225 = 1.61666…
    //   有偏變異數   = 1.61666… / 1.875 = 0.862222…
    //   校正因子     = sumW² / (sumW² − sumW2) = 3.515625 / 2.1875 = 45/28
    //   變異數       = 0.862222… × 45/28 = 97/70
    const variance = 97 / 70;
    expect(ewmStd([1, 2, 3, 4], 3)!).toBeCloseTo(Math.sqrt(variance), 12);
  });

  it('最新一筆權重最大：把最後一個值改大，標準差跟著變大', () => {
    const calm = ewmStd([1, 1, 1, 1, 1.01], 5)!;
    const spike = ewmStd([1, 1, 1, 1, 2], 5)!;
    expect(spike).toBeGreaterThan(calm);
  });

  it('樣本不足 2 筆回 null，不回 0', () => {
    expect(ewmStd([], 100)).toBeNull();
    expect(ewmStd([0.01], 100)).toBeNull();
  });

  it('全部相同時變異數為 0 → 回 null（0 波動會讓停損價等於進場價）', () => {
    expect(ewmStd([0.01, 0.01, 0.01, 0.01], 100)).toBeNull();
  });
});

describe('estimateDailyVolatility', () => {
  it('觀測數不足時回 null 並說明還差多少，不退回預設值', () => {
    const out = estimateDailyVolatility([100, 101, 102], 100, 20);
    expect(out.sigmaDaily).toBeNull();
    expect(out.observations).toBe(2);
    expect(out.reason).toContain('需要 20 筆');
  });

  it('觀測數足夠時給得出正的波動率', () => {
    // 造 25 個交易日、每日 ±1% 交替的價格序列
    const closes = [100];
    for (let i = 0; i < 25; i += 1) {
      closes.push(closes[closes.length - 1]! * (i % 2 === 0 ? 1.01 : 0.99));
    }
    const out = estimateDailyVolatility(closes, 100, 20);
    expect(out.sigmaDaily).toBeGreaterThan(0);
    expect(out.observations).toBe(25);
    expect(out.reason).toBeNull();
    // ±1% 交替的日波動應該在 1% 附近
    expect(out.sigmaDaily!).toBeGreaterThan(0.005);
    expect(out.sigmaDaily!).toBeLessThan(0.02);
  });

  it('價格完全不動時回 null 而不是 0 波動', () => {
    const flat = new Array<number>(30).fill(50);
    const out = estimateDailyVolatility(flat, 100, 20);
    expect(out.sigmaDaily).toBeNull();
    expect(out.reason).toContain('標準差');
  });
});
