import { describe, expect, it } from 'vitest';
import type { ExRightEvent } from '../../l5/exright';
import {
  BENCHMARK_CODE,
  buildOfficialIndex,
  normalizeTaiexTotalReturn,
  benchmarkReturn,
  buildTotalReturnIndex,
  maxDrawdown,
} from '../benchmark';
import type { BenchmarkBar } from '../benchmark';
import {
  MIN_SAMPLE_FOR_VERDICT,
  compareSplit,
  compareToBenchmark,
  toExcessObservations,
} from '../comparison';
import type { MatchedObservation } from '../comparison';

function bars(entries: readonly (readonly [string, number])[]): Map<string, BenchmarkBar> {
  return new Map(entries.map(([date, close]) => [date, { date, close }]));
}

const DIVIDEND: ExRightEvent = {
  code: BENCHMARK_CODE,
  market: 'TWSE',
  exDate: '2026-08-18',
  cashDividend: 2,
  stockDividendRatio: 0,
  hasRightsIssue: false,
  kind: '息',
};

describe('基準報酬', () => {
  const priceBars = bars([
    ['2026-08-14', 100],
    ['2026-08-17', 101],
    ['2026-08-18', 99],
    ['2026-08-19', 102],
  ]);

  it('無配息時就是價格報酬', () => {
    expect(benchmarkReturn(priceBars, [], '2026-08-14', '2026-08-17')).toBeCloseTo(0.01, 10);
  });

  it('期間配息要加回來（否則會低估基準，等於放水）', () => {
    // 100 → 99 帳面 −1%，但配息 2 元 → 實際 +1%
    expect(benchmarkReturn(priceBars, [DIVIDEND], '2026-08-14', '2026-08-18')).toBeCloseTo(0.01, 10);
    // 不還原的話會低估
    expect(benchmarkReturn(priceBars, [], '2026-08-14', '2026-08-18')).toBeCloseTo(-0.01, 10);
  });

  it('任一端沒有價格就回 null，不內插也不猜', () => {
    expect(benchmarkReturn(priceBars, [], '2026-08-14', '2026-08-20')).toBeNull();
    expect(benchmarkReturn(priceBars, [], '2026-08-13', '2026-08-17')).toBeNull();
  });

  it('與個股用同一套區間規則（左開右閉）', () => {
    // 進場日當天的除息不算進來
    const sameDay: ExRightEvent = { ...DIVIDEND, exDate: '2026-08-14' };
    expect(benchmarkReturn(priceBars, [sameDay], '2026-08-14', '2026-08-17')).toBeCloseTo(0.01, 10);
  });
});

describe('總報酬指數與最大回撤', () => {
  it('指數起點為 100，逐日累乘', () => {
    const points = buildTotalReturnIndex(
      [
        { date: '2026-08-14', close: 100 },
        { date: '2026-08-17', close: 110 },
        { date: '2026-08-18', close: 99 },
      ],
      [],
    );
    expect(points[0]!.totalReturnIndex).toBe(100);
    expect(points[1]!.totalReturnIndex).toBeCloseTo(110, 8);
    expect(points[2]!.totalReturnIndex).toBeCloseTo(99, 8);
  });

  it('除息當日不會被算成下跌（指數用含息報酬）', () => {
    const points = buildTotalReturnIndex(
      [
        { date: '2026-08-17', close: 100 },
        { date: '2026-08-18', close: 98 }, // 除息 2 元後原地不動
      ],
      [DIVIDEND],
    );
    expect(points[1]!.totalReturnIndex).toBeCloseTo(100, 8);
    expect(points[1]!.cashDividend).toBe(2);
  });

  it('最大回撤用指數算，不是用價格', () => {
    const points = buildTotalReturnIndex(
      [
        { date: '2026-08-14', close: 100 },
        { date: '2026-08-17', close: 120 },
        { date: '2026-08-18', close: 90 },
        { date: '2026-08-19', close: 110 },
      ],
      [],
    );
    // 高點 120 跌到 90 → 回撤 25%
    expect(maxDrawdown(points)).toBeCloseTo(0.25, 8);
  });

  it('一路上漲時回撤為 0', () => {
    const points = buildTotalReturnIndex(
      [
        { date: '2026-08-14', close: 100 },
        { date: '2026-08-17', close: 110 },
      ],
      [],
    );
    expect(maxDrawdown(points)).toBe(0);
  });

  it('輸入順序顛倒也算得對（內部會排序）', () => {
    const points = buildTotalReturnIndex(
      [
        { date: '2026-08-18', close: 90 },
        { date: '2026-08-14', close: 100 },
      ],
      [],
    );
    expect(points.map((p) => p.date)).toEqual(['2026-08-14', '2026-08-18']);
    expect(points[1]!.totalReturnIndex).toBeCloseTo(90, 8);
  });
});

describe('與基準對照（G3）', () => {
  function obs(assetPct: number, benchPct: number | null = 0): MatchedObservation {
    return {
      code: '2330',
      dataAsOf: '2026-08-14',
      exitDate: '2026-08-21',
      horizon: 5,
      assetReturnPct: assetPct,
      benchmarkReturnPct: benchPct,
    };
  }

  it('基準缺價格的觀察值被排除，並如實回報筆數', () => {
    const result = compareToBenchmark([obs(5), obs(3, null), obs(1)], 5);
    expect(result.sampleSize).toBe(2);
    expect(result.unmatched).toBe(1);
  });

  it('樣本 < 30 筆一律不下結論（CLAUDE.md 硬規定）', () => {
    const many = Array.from({ length: MIN_SAMPLE_FOR_VERDICT - 1 }, () => obs(10, 1));
    const result = compareToBenchmark(many, 5);
    expect(result.status).toBe('insufficient_sample');
    expect(result.verdict).toContain('不下結論');
    // 即使每一筆都大勝，仍然不給結論
    expect(result.meanExcessPct).toBeCloseTo(9, 10);
  });

  it('樣本足夠且平均超額為正 → beats_benchmark', () => {
    const many = Array.from({ length: MIN_SAMPLE_FOR_VERDICT }, (_, i) => obs(5 + (i % 3), 2));
    const result = compareToBenchmark(many, 5);
    expect(result.status).toBe('beats_benchmark');
    expect(result.meanExcessPct).toBeGreaterThan(0);
    // 即使勝出也要提醒尚未做 DSR 與 Purged CV
    expect(result.verdict).toContain('Deflated Sharpe');
  });

  it('大盤漲更多時，正報酬也算輸', () => {
    // 個股漲 8%，但 0050 漲 10% → 超額 −2pp
    const many = Array.from({ length: MIN_SAMPLE_FOR_VERDICT }, () => obs(8, 10));
    const result = compareToBenchmark(many, 5);
    expect(result.meanAssetPct).toBeCloseTo(8, 10);
    expect(result.status).toBe('does_not_beat');
    expect(result.verdict).toContain('無存在價值');
  });

  it('超額報酬的離散度會被算出來（穩定性）', () => {
    // 兩組的平均超額都是 +2pp：
    //   穩定組交替 3.1−1=2.1 與 2.9−1=1.9 → 平均 2，離散度極小
    //   波動組交替 23−1=22 與 −17−1=−18   → 平均 2，離散度極大
    const steady = Array.from({ length: 30 }, (_, i) => obs(i % 2 === 0 ? 3.1 : 2.9, 1));
    const volatile = Array.from({ length: 30 }, (_, i) => obs(i % 2 === 0 ? 23 : -17, 1));
    const a = compareToBenchmark(steady, 5);
    const b = compareToBenchmark(volatile, 5);
    expect(a.meanExcessPct).toBeCloseTo(b.meanExcessPct, 6);
    expect(a.excessStdevPct).toBeLessThan(b.excessStdevPct);
    expect(a.excessMeanOverStdev!).toBeGreaterThan(b.excessMeanOverStdev!);
  });

  it('超額報酬完全沒有離散時，比值回 null 而不是無限大', () => {
    // 每筆超額都恰好相同 → 標準差為 0 → 比值在數學上未定義。
    // 回 null 而不是 Infinity，避免下游把它當成「風險調整後無限好」。
    const identical = Array.from({ length: 30 }, () => obs(3, 1));
    const result = compareToBenchmark(identical, 5);
    expect(result.excessStdevPct).toBe(0);
    expect(result.excessMeanOverStdev).toBeNull();
    // 但平均超額仍然算得出來，判定不受影響
    expect(result.meanExcessPct).toBeCloseTo(2, 10);
    expect(result.status).toBe('beats_benchmark');
  });

  it('勝率只當敘述性資訊，不影響判定', () => {
    // 29 次小贏 1 次大賠：勝率 96.7%，但平均超額為負
    const observations = [
      ...Array.from({ length: 29 }, () => obs(1, 0)),
      obs(-100, 0),
    ];
    const result = compareToBenchmark(observations, 5);
    expect(result.beatCount).toBe(29);
    expect(result.status).toBe('does_not_beat'); // 勝率高也照樣判輸
  });

  it('toExcessObservations 只保留可比較者', () => {
    expect(toExcessObservations([obs(5), obs(3, null)])).toHaveLength(1);
    expect(toExcessObservations([obs(5, 2)])[0]!.excessPct).toBeCloseTo(3, 10);
  });
});

describe('觀察榜 vs 交易訊號分開比較', () => {
  function make(assetPct: number, n: number): MatchedObservation[] {
    return Array.from({ length: n }, () => ({
      code: '2330',
      dataAsOf: '2026-08-14',
      exitDate: '2026-08-21',
      horizon: 5,
      assetReturnPct: assetPct,
      benchmarkReturnPct: 0,
    }));
  }

  it('排序贏但整套系統輸 → 指出 L2／L3 在扣分', () => {
    const result = compareSplit(make(5, 30), make(-2, 30), 5);
    expect(result.interpretation).toContain('把好的標的擋掉');
  });

  it('排序輸但整套系統贏 → 篩選有效', () => {
    const result = compareSplit(make(-2, 30), make(3, 30), 5);
    expect(result.interpretation).toContain('篩選是有效的');
  });

  it('兩者都輸 → 問題在因子不在否決層', () => {
    const result = compareSplit(make(-2, 30), make(-3, 30), 5);
    expect(result.interpretation).toContain('問題在 L1 的因子');
  });

  it('樣本不足時不做任何解讀', () => {
    const result = compareSplit(make(5, 3), make(5, 3), 5);
    expect(result.interpretation).toContain('無法判斷');
  });
});

/**
 * P11.15：官方加權股價報酬指數（MFI94U）。
 *
 * 最重要的一則是「不再做除權息還原」—— 這個指數本身已含息，
 * 對它套用 0050 那套配息加回的邏輯會把股利算兩次。
 */
describe('normalizeTaiexTotalReturn / buildOfficialIndex', () => {
  const SNAP = [
    { Date: '1150818', TAIEXTotalReturnIndex: '38,000.00' },
    { Date: '1150819', TAIEXTotalReturnIndex: '38,380.00' },
  ];

  it('民國日期轉 ISO，千分位逗號去掉', () => {
    const out = normalizeTaiexTotalReturn(SNAP);
    expect(out).toEqual([
      { date: '2026-08-18', value: 38000 },
      { date: '2026-08-19', value: 38380 },
    ]);
  });

  it('日期或數值壞掉的列略過，不猜也不拋錯', () => {
    const out = normalizeTaiexTotalReturn([
      { Date: 'x', TAIEXTotalReturnIndex: '1' },
      { Date: '1150819', TAIEXTotalReturnIndex: 'N/A' },
      { Date: '1150819', TAIEXTotalReturnIndex: '0' },
      { Date: '1150820', TAIEXTotalReturnIndex: '100' },
    ]);
    expect(out).toEqual([{ date: '2026-08-20', value: 100 }]);
  });

  it('不是陣列時回空', () => {
    expect(normalizeTaiexTotalReturn(null)).toEqual([]);
    expect(normalizeTaiexTotalReturn({ a: 1 })).toEqual([]);
  });

  it('起始日正規化為 100，比值正確', () => {
    const index = buildOfficialIndex([normalizeTaiexTotalReturn(SNAP)]);
    expect(index[0]?.totalReturnIndex).toBeCloseTo(100, 10);
    expect(index[1]?.totalReturnIndex).toBeCloseTo(101, 10);
  });

  it('多份滾動視窗快照合併後日期唯一且遞增', () => {
    const a = normalizeTaiexTotalReturn(SNAP);
    const b = normalizeTaiexTotalReturn([{ Date: '1150817', TAIEXTotalReturnIndex: '37000' }]);
    const index = buildOfficialIndex([a, b]);
    expect(index.map((p) => p.date)).toEqual(['2026-08-17', '2026-08-18', '2026-08-19']);
    expect(index[0]?.totalReturnIndex).toBeCloseTo(100, 10);
  });

  /**
   * 官方若事後修正歷史值，我們取**最早抓到**的那一份。
   * 用後來修正的數字回頭評估當時的決策就是前視偏誤。
   */
  it('同一天在多份快照中值不同時，取先出現的那一份', () => {
    const first = [{ date: '2026-08-19', value: 100 }];
    const later = [{ date: '2026-08-19', value: 999 }];
    expect(buildOfficialIndex([first, later])[0]?.close).toBe(100);
  });

  it('指數已含息，故配息欄恆為 0 —— 不可再做除權息還原', () => {
    const index = buildOfficialIndex([normalizeTaiexTotalReturn(SNAP)]);
    for (const p of index) {
      expect(p.cashDividend).toBe(0);
      expect(p.stockDividendRatio).toBe(0);
    }
  });

  it('空輸入回空陣列，不會算出 NaN', () => {
    expect(buildOfficialIndex([])).toEqual([]);
    expect(buildOfficialIndex([[]])).toEqual([]);
  });
});
