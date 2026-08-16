import { describe, expect, it } from 'vitest';
import {
  midranksAscending,
  quantileType7,
  ranksToScores,
  scoreCrossSection,
  winsorize,
} from '../scoring';

describe('quantileType7', () => {
  it('與 numpy.percentile 預設一致（手算驗證）', () => {
    // numpy.percentile([1,2,3,4], 25) = 1.75
    //   h = (4-1)*0.25 = 0.75 → 1 + 0.75*(2-1) = 1.75
    expect(quantileType7([1, 2, 3, 4], 25)).toBeCloseTo(1.75, 12);
    // numpy.percentile([1,2,3,4], 50) = 2.5
    expect(quantileType7([1, 2, 3, 4], 50)).toBeCloseTo(2.5, 12);
    // 端點就是最小 / 最大值
    expect(quantileType7([1, 2, 3, 4], 0)).toBe(1);
    expect(quantileType7([1, 2, 3, 4], 100)).toBe(4);
  });

  it('只有一筆時任何分位數都是它自己', () => {
    expect(quantileType7([7], 1)).toBe(7);
    expect(quantileType7([7], 99)).toBe(7);
  });

  it('空陣列直接拋錯，不回 0', () => {
    expect(() => quantileType7([], 50)).toThrow('空陣列');
  });
});

describe('winsorize', () => {
  it('極端值被夾到分位數，筆數不變', () => {
    const values = [-1000, 1, 2, 3, 4, 5, 6, 7, 8, 9999];
    const out = winsorize(values, 10, 90);
    expect(out).toHaveLength(values.length);
    // 10% 與 90% 分位數（type 7，n=10 排序後）
    const sorted = [...values].sort((a, b) => a - b);
    const lo = quantileType7(sorted, 10);
    const hi = quantileType7(sorted, 90);
    expect(out[0]).toBe(lo);
    expect(out[9]).toBe(hi);
    // 中間的值原封不動
    expect(out.slice(1, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('保持原本的順序，不排序輸入', () => {
    expect(winsorize([3, 1, 2], 0, 100)).toEqual([3, 1, 2]);
  });

  it('未造成平手時名次完全不變（縮尾保持大小順序）', () => {
    const values = [-1e9, 1, 2, 3, 1e9];
    const before = midranksAscending(values);
    const after = midranksAscending(winsorize(values, 1, 99));
    expect(after).toEqual(before);
  });

  it('被夾到同一個分位數的極端值會變成平手 —— 名次因此改變', () => {
    // 這是縮尾對排序的真實影響。1%/99% 套在上千檔的橫斷面時，
    // 最強的一批會共用滿分，而不是分出高下。
    const values = [-1e9, -1e8, 1, 2, 3, 1e8, 1e9];
    const before = midranksAscending(values);
    const after = midranksAscending(winsorize(values, 25, 75));
    expect(after).not.toEqual(before);
    // 最低的兩檔被夾成相同的值 → 相同名次
    expect(after[0]).toBe(after[1]);
    // 最高的兩檔亦然
    expect(after[5]).toBe(after[6]);
    // 但大小順序沒有反轉
    expect(after[0]!).toBeLessThan(after[3]!);
    expect(after[6]!).toBeGreaterThan(after[3]!);
  });
});

describe('midranksAscending', () => {
  it('平手給平均名次', () => {
    expect(midranksAscending([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });

  it('全部相同時所有人拿同一個名次', () => {
    expect(midranksAscending([0, 0, 0, 0])).toEqual([2.5, 2.5, 2.5, 2.5]);
  });

  it('不受輸入順序影響：同樣的值集合，同樣的值拿同樣的名次', () => {
    const a = midranksAscending([5, 1, 5, 3]);
    const b = midranksAscending([1, 3, 5, 5]);
    // 值 5 在兩邊都應該拿到 3.5
    expect(a[0]).toBe(3.5);
    expect(a[2]).toBe(3.5);
    expect(b[2]).toBe(3.5);
    expect(b[3]).toBe(3.5);
  });
});

describe('ranksToScores', () => {
  it('higher_is_better：最大值 1、最小值 0', () => {
    const scores = ranksToScores(midranksAscending([1, 2, 3]), 'higher_is_better');
    expect(scores).toEqual([0, 0.5, 1]);
  });

  it('lower_is_better：方向反過來', () => {
    const scores = ranksToScores(midranksAscending([1, 2, 3]), 'lower_is_better');
    expect(scores).toEqual([1, 0.5, 0]);
  });

  it('只有一檔時給中性 0.5，不給滿分', () => {
    expect(ranksToScores(midranksAscending([42]), 'higher_is_better')).toEqual([0.5]);
  });

  it('全部平手時每個人都是 0.5', () => {
    expect(ranksToScores(midranksAscending([7, 7, 7]), 'higher_is_better')).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('scoreCrossSection', () => {
  it('大量平手（多數投信買超為 0）不會依陣列順序給出不同分數', () => {
    // 真實情況：多數個股投信買賣超為 0
    const values = [0, 0, 0, 0, 5, -3];
    const { scores } = scoreCrossSection(values, 'higher_is_better', 1, 99);
    // 四個 0 必須拿到完全相同的分數
    expect(new Set(scores.slice(0, 4)).size).toBe(1);
    // -3 最低、5 最高
    expect(scores[5]).toBe(0);
    expect(scores[4]).toBe(1);
  });

  it('lower_is_better 的因子（融資增幅）最小值得最高分', () => {
    const values = [0.5, 0.1, -0.2];
    const { scores } = scoreCrossSection(values, 'lower_is_better', 1, 99);
    expect(scores[2]).toBe(1);
    expect(scores[0]).toBe(0);
  });
});
