/**
 * 白話轉換的測試。
 *
 * 【最重要的兩則在最後面】
 * 「每個已登記因子都要有白話說明」與「方向不得與登記的假設相反」。
 * 前者確保不會有人看不懂的因子出現在日報上；
 * 後者確保不會把「利空」寫成「利多」—— 那比看不懂嚴重得多。
 */

import { describe, expect, it } from 'vitest';

import { V1_FACTORS } from '../../l1/factors/definitions';
import {
  PLAIN_FACTORS,
  SHARES_PER_LOT,
  explainFactors,
  formatLots,
  formatMoney,
  priceMove,
  signedPct,
} from '../explain';

describe('priceMove — 漲跌與昨收', () => {
  it('上漲：反推昨收、算出漲幅、用 ▲', () => {
    // 2026-08-19 興富發實際數字
    const m = priceMove(48.15, 0.4, null);
    expect(m.prevClose).toBeCloseTo(47.75, 10);
    expect(m.pct).toBeCloseTo(0.8377, 3);
    expect(m.arrow).toBe('▲');
    expect(m.text).toBe('▲0.40（+0.84%）');
  });

  it('下跌：用 ▼ 且漲跌幅為負', () => {
    const m = priceMove(484, -4, null);
    expect(m.prevClose).toBeCloseTo(488, 10);
    expect(m.arrow).toBe('▼');
    expect(m.text).toContain('-0.82%');
  });

  it('平盤用破折號，不用箭頭', () => {
    expect(priceMove(100, 0, null).arrow).toBe('—');
  });

  /**
   * 除權息日官方的 change 是相對於除權息參考價，不是相對於昨天的收盤價。
   * 反推會得到一個看起來很合理、但完全錯誤的「昨收」。
   */
  it('除權息日不得反推昨收', () => {
    const m = priceMove(30, null, '除息');
    expect(m.prevClose).toBeNull();
    expect(m.pct).toBeNull();
    expect(m.text).toContain('除息');
    expect(m.text).toContain('不可與昨收直接比較');
  });

  it('除權息註記逐字保留，不改寫不摘要', () => {
    expect(priceMove(30, null, '除權息').text).toContain('除權息');
  });

  it('漲跌資料缺漏時說缺漏，不當成 0', () => {
    const m = priceMove(30, null, null);
    expect(m.prevClose).toBeNull();
    expect(m.text).toBe('漲跌資料缺漏');
  });

  it('昨收為 0 時不計算漲跌幅，避免除以零', () => {
    expect(priceMove(5, 5, null).pct).toBeNull();
  });
});

describe('成交量與金額的顯示', () => {
  it('一張等於一千股，兩個市場的來源都以股為單位', () => {
    expect(SHARES_PER_LOT).toBe(1000);
    // 2026-08-19 興富發 TradeVolume=13205723
    expect(formatLots(13_205_723)).toBe('13,206 張');
  });

  it('沒有資料時顯示破折號，不顯示 0 張', () => {
    expect(formatLots(null)).toBe('—');
    expect(formatLots(null)).not.toContain('0');
  });

  it('金額按量級換算，原樣顯示沒有人讀得出來', () => {
    expect(formatMoney(633_242_570)).toBe('6.33 億');
    expect(formatMoney(50_000)).toBe('5.0 萬');
    expect(formatMoney(1234)).toBe('1,234 元');
    expect(formatMoney(null)).toBe('—');
  });

  it('負金額也照量級換算', () => {
    expect(formatMoney(-633_242_570)).toBe('-6.33 億');
  });
});

describe('signedPct — 正號要寫出來', () => {
  it('正數帶 +，負數帶 -', () => {
    expect(signedPct(0.84)).toBe('+0.84%');
    expect(signedPct(-2.56)).toBe('-2.56%');
    expect(signedPct(0)).toBe('+0.00%');
  });
});

describe('explainFactors', () => {
  const score = (factorKey: string, rawValue: number | null, imputed = false) => ({
    factorKey,
    direction: 'higher_is_better' as const,
    rawValue,
    winsorizedValue: rawValue,
    score: 0.5,
    imputed,
  });

  it('用白話標籤取代 factorKey', () => {
    const out = explainFactors([score('rev_yoy_momentum_v1', 202.646)]);
    expect(out[0]?.label).toBe('月營收年增');
    expect(out[0]?.valueText).toBe('+202.6%');
  });

  it('比例型因子換算成百分比並註明是佔成交量', () => {
    const out = explainFactors([score('foreign_net_buy_ratio_v1', 0.0960786)]);
    expect(out[0]?.valueText).toBe('佔成交量 +9.6%');
  });

  /**
   * 補值是「這檔沒有這項資料，填中性值以免影響排序」。
   * 顯示它等於把系統的假設當成公司的數字報給人看 —— 那就是捏造。
   */
  it('補值的因子一律不列出', () => {
    const out = explainFactors([
      score('rev_yoy_momentum_v1', 50),
      score('trust_net_buy_ratio_v1', 0.5, true),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.factorKey).toBe('rev_yoy_momentum_v1');
  });

  it('原始值為 null 的因子不列出', () => {
    expect(explainFactors([score('rev_yoy_momentum_v1', null)])).toHaveLength(0);
  });

  it('沒有白話說明的因子照樣列出 factorKey 與原始值，不編造說法', () => {
    const out = explainFactors([score('unknown_factor_v9', 1.5)]);
    expect(out[0]?.label).toBe('unknown_factor_v9');
    expect(out[0]?.valueText).toBe('1.5');
  });
});

/**
 * 這兩則是本檔的重點：把白話說明與已登記因子綁在一起。
 * 沒有它們，新增一個因子時很容易忘了補說明，
 * 於是日報上出現一行 `margin_balance_change_v2 -0.03`，等於沒有揭露。
 */
describe('白話說明必須與 factor_registry 對齊', () => {
  it('每個已登記因子都有白話說明', () => {
    const missing = V1_FACTORS.filter((f) => PLAIN_FACTORS[f.factorKey] === undefined).map(
      (f) => f.factorKey,
    );
    expect(missing).toEqual([]);
  });

  it('說明的方向不得與登記的假設方向相反', () => {
    for (const f of V1_FACTORS) {
      const plain = PLAIN_FACTORS[f.factorKey];
      expect(plain, `${f.factorKey} 缺白話說明`).toBeDefined();
      const expected = f.hypothesisDirection === 'lower_is_better' ? 'lower' : 'higher';
      expect(plain!.betterWhen, `${f.factorKey} 方向寫反`).toBe(expected);
    }
  });

  it('每個說明都寫得出這個數字在講什麼', () => {
    for (const [key, plain] of Object.entries(PLAIN_FACTORS)) {
      expect(plain.label.length, `${key} 標籤是空的`).toBeGreaterThan(0);
      expect(plain.meaning.length, `${key} 說明太短`).toBeGreaterThan(10);
    }
  });
});
