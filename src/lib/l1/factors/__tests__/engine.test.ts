import { describe, expect, it } from 'vitest';
import type { FactorRegistrationInput } from '../../../factors/types';
import type { DailyQuote, InstitutionalRow, MarginRow, MonthlyRevenueRow } from '../../types';
import { buildUniverse } from '../../universe';
import type { UniverseEntry } from '../../types';
import { DataAsOfMismatchError, alignDataAsOf, buildFactorContext } from '../context';
import { TRUST_NET_BUY_RATIO_V1, V1_FACTORS } from '../definitions';
import {
  FACTOR_IMPLS,
  NEUTRAL_SCORE,
  rankUniverse,
  selectLatestRevenue,
  watchlist,
} from '../engine';

// ── 測試資料建構 ─────────────────────────────────────────────────────────────

const DAY = '2026-08-15';

function entry(code: string): UniverseEntry {
  return {
    code,
    market: 'TWSE',
    name: `公司${code}`,
    industryCode: '01',
    listingDate: '2000-01-01',
    paidInCapital: 1_000_000,
    issuedShares: 100_000,
  };
}

function quote(code: string, close: number, opts: Partial<DailyQuote> = {}): DailyQuote {
  return {
    code,
    market: 'TWSE',
    date: DAY,
    open: close,
    high: close,
    low: close,
    close,
    change: 0,
    changeNote: null,
    volumeShares: 1_000_000,
    turnoverValue: close * 1_000_000,
    transactions: 100,
    ...opts,
  };
}

function inst(code: string, trustNet: number | null, foreignNet: number | null): InstitutionalRow {
  return { code, market: 'TWSE', date: DAY, foreignNet, trustNet, dealerNet: 0, totalNet: 0 };
}

function margin(code: string, prev: number | null, today: number | null): MarginRow {
  return {
    code,
    market: 'TWSE',
    date: DAY,
    marginBalancePrevDay: prev,
    marginBalance: today,
    shortBalancePrevDay: 0,
    shortBalance: 0,
  };
}

function revenue(
  code: string,
  period: string,
  reportDate: string,
  yoyPct: number | null,
): MonthlyRevenueRow {
  return { code, market: 'TWSE', reportDate, period, revenue: 1000, yoyPct, momPct: 0 };
}

/** 只有當日、沒有歷史的最小情境 */
function contextFor(
  codes: readonly string[],
  overrides: {
    quotes?: readonly DailyQuote[];
    institutional?: readonly InstitutionalRow[];
    margin?: readonly MarginRow[];
    monthlyRevenue?: readonly MonthlyRevenueRow[];
    history?: readonly { date: string; quotes: readonly DailyQuote[] }[];
  } = {},
) {
  const quotes = overrides.quotes ?? codes.map((c, i) => quote(c, 100 + i));
  return buildFactorContext({
    dataAsOf: DAY,
    quotes,
    institutional: overrides.institutional ?? [],
    margin: overrides.margin ?? [],
    monthlyRevenue: overrides.monthlyRevenue ?? [],
    history: overrides.history ?? [{ date: DAY, quotes }],
  });
}

// ── 登記與實作的對應 ─────────────────────────────────────────────────────────

describe('登記定義與引擎實作必須一一對應', () => {
  it('每個已登記的因子都有實作', () => {
    for (const factor of V1_FACTORS) {
      expect(FACTOR_IMPLS.has(factor.factorKey), factor.factorKey).toBe(true);
    }
  });

  it('沒有「有實作但沒登記」的孤兒因子', () => {
    const registered = new Set(V1_FACTORS.map((f) => f.factorKey));
    for (const key of FACTOR_IMPLS.keys()) {
      expect(registered.has(key), key).toBe(true);
    }
  });

  it('實作的公式字串與登記定義的 value 逐字相同', () => {
    // 改了公式卻沒改登記（或反之），這裡就會紅。
    // definition 一經登記即鎖定，故真正該被擋下的是「偷改公式」。
    for (const factor of V1_FACTORS) {
      const impl = FACTOR_IMPLS.get(factor.factorKey)!;
      expect(impl.valueExpr, factor.factorKey).toBe(factor.definition['value']);
    }
  });

  it('登記了但引擎沒實作 → 直接拋錯，不靜默略過', () => {
    const bogus: FactorRegistrationInput = {
      ...TRUST_NET_BUY_RATIO_V1,
      factorKey: 'not_implemented_v1',
    };
    expect(() => rankUniverse(buildUniverse([entry('1101')]), contextFor(['1101']), [bogus])).toThrow(
      '已登記但引擎沒有實作',
    );
  });
});

// ── 參數取自登記定義，不是寫死 ───────────────────────────────────────────────

describe('計算參數來自登記定義', () => {
  it('縮尾百分位改了，縮尾後的值就跟著改（證明不是寫死 1/99）', () => {
    const codes = ['1101', '1102', '1103', '1104', '1105'];
    const ctx = contextFor(codes, {
      institutional: [
        inst('1101', -1_000_000, 0),
        inst('1102', 10, 0),
        inst('1103', 20, 0),
        inst('1104', 30, 0),
        inst('1105', 1_000_000, 0),
      ],
    });
    const universe = buildUniverse(codes.map(entry));

    const tight: FactorRegistrationInput = {
      ...TRUST_NET_BUY_RATIO_V1,
      definition: { ...TRUST_NET_BUY_RATIO_V1.definition, winsorize: { lower_pct: 25, upper_pct: 75 } },
    };

    const loose = rankUniverse(universe, ctx, [TRUST_NET_BUY_RATIO_V1]);
    const clipped = rankUniverse(universe, ctx, [tight]);

    const scoreOf = (r: ReturnType<typeof rankUniverse>, code: string) =>
      r.ranked.find((s) => s.code === code)!.factorScores[0]!;

    // 1/99 縮尾在 n=5 時幾乎不動；25/75 縮尾會把最極端的兩檔夾進來
    expect(scoreOf(loose, '1105').winsorizedValue).toBeGreaterThan(
      scoreOf(clipped, '1105').winsorizedValue!,
    );
    // 原始值一律不受縮尾影響，如實保留
    expect(scoreOf(loose, '1105').rawValue).toBe(scoreOf(clipped, '1105').rawValue);

    // 縮尾夾出來的平手會反映在分數上：25/75 之下最高的兩檔同分
    expect(scoreOf(clipped, '1105').score).toBe(scoreOf(clipped, '1104').score);
    // 1/99 之下五檔分數全不相同
    expect(new Set(loose.ranked.map((s) => s.factorScores[0]!.score)).size).toBe(5);
  });

  it('假設方向取自登記：融資增幅是 lower_is_better，增幅最小者得最高分', () => {
    const codes = ['1101', '1102', '1103'];
    const ctx = contextFor(codes, {
      margin: [
        margin('1101', 1000, 1500), // +50%
        margin('1102', 1000, 1000), // 0%
        margin('1103', 1000, 800), // -20%
      ],
    });
    const result = rankUniverse(
      buildUniverse(codes.map(entry)),
      ctx,
      V1_FACTORS.filter((f) => f.factorKey === 'margin_balance_change_v1'),
    );
    expect(result.ranked[0]!.code).toBe('1103');
    expect(result.ranked[0]!.compositeScore).toBe(1);
    expect(result.ranked[2]!.code).toBe('1101');
    expect(result.ranked[2]!.compositeScore).toBe(0);
  });
});

// ── 缺值處理 ─────────────────────────────────────────────────────────────────

describe('缺值補中性值 0.5', () => {
  const codes = ['1101', '1102', '1103'];

  it('沒有的因子補 0.5 並標記 imputed，realFactorCount 如實計算', () => {
    const ctx = contextFor(codes, {
      // 只有 1101 有法人資料
      institutional: [inst('1101', 500, 500)],
      margin: codes.map((c) => margin(c, 1000, 1000)),
    });
    const result = rankUniverse(buildUniverse(codes.map(entry)), ctx);

    const s1102 = result.ranked.find((s) => s.code === '1102')!;
    const trust = s1102.factorScores.find((f) => f.factorKey === 'trust_net_buy_ratio_v1')!;
    expect(trust.imputed).toBe(true);
    expect(trust.score).toBe(NEUTRAL_SCORE);
    expect(trust.rawValue).toBeNull();
    // 1102 只有融資因子是真的
    expect(s1102.realFactorCount).toBe(1);

    const s1101 = result.ranked.find((s) => s.code === '1101')!;
    expect(s1101.realFactorCount).toBe(3); // 投信、外資、融資
  });

  it('補值會把資料少的股票拉回中間，而不是推上榜首', () => {
    // 1101 只有投信一個因子，而且是全場最高分（score = 1）
    // 1102 投信略遜於 1101，但外資與融資都拿滿分
    const four = ['1101', '1102', '1103', '1104'];
    const ctx = contextFor(four, {
      institutional: [
        inst('1101', 10, null),
        inst('1102', 9, 10),
        inst('1103', 1, 1),
        inst('1104', 2, 2),
      ],
      margin: [margin('1102', 1000, 900), margin('1103', 1000, 1100), margin('1104', 1000, 1050)],
    });
    const result = rankUniverse(buildUniverse(four.map(entry)), ctx);
    const s1101 = result.ranked.find((s) => s.code === '1101')!;
    const s1102 = result.ranked.find((s) => s.code === '1102')!;

    // 1101 的投信分數確實是全場最高
    expect(s1101.factorScores.find((f) => f.factorKey === 'trust_net_buy_ratio_v1')!.score).toBe(1);
    expect(s1101.realFactorCount).toBe(1);
    expect(s1102.realFactorCount).toBe(3);
    // 但另外兩個因子補 0.5，稀釋掉了那個滿分
    expect(s1101.compositeScore).toBeLessThan(s1102.compositeScore);
    expect(result.ranked[0]!.code).toBe('1102');
  });

  it('五個因子全無資料的股票不進排序，並計入 excludedNoFactorData', () => {
    const ctx = contextFor(codes, { institutional: [inst('1101', 100, 100)] });
    const result = rankUniverse(buildUniverse(codes.map(entry)), ctx);
    expect(result.ranked.map((s) => s.code)).toEqual(['1101']);
    expect(result.excludedNoFactorData).toBe(2);
    expect(result.rankedCount).toBe(1);
    expect(result.tradableCount).toBe(3);
  });

  it('不可交易（無成交量）的股票連候選都不是', () => {
    const quotes = [
      quote('1101', 100),
      quote('1102', 100, { volumeShares: 0 }),
      quote('1103', 100, { close: null }),
    ];
    const ctx = contextFor(codes, {
      quotes,
      history: [{ date: DAY, quotes }],
      institutional: codes.map((c) => inst(c, 100, 100)),
    });
    const result = rankUniverse(buildUniverse(codes.map(entry)), ctx);
    expect(result.tradableCount).toBe(1);
    expect(result.ranked.map((s) => s.code)).toEqual(['1101']);
  });
});

// ── 五日反轉因子 ─────────────────────────────────────────────────────────────

describe('五日反轉因子（需要 6 個交易日）', () => {
  const codes = ['1101', '1102'];
  const dates = ['2026-08-06', '2026-08-07', '2026-08-10', '2026-08-11', '2026-08-12', DAY];

  function historyWith(closes: Record<string, readonly (number | null)[]>, note?: [string, number]) {
    return dates.map((date, i) => ({
      date,
      quotes: codes
        .filter((c) => closes[c]![i] !== null)
        .map((c) =>
          quote(c, closes[c]![i]!, {
            date,
            changeNote: note !== undefined && note[0] === c && note[1] === i ? '除息' : null,
          }),
        ),
    }));
  }

  it('交易日不足時整個因子停用，並說明還差幾天', () => {
    const ctx = contextFor(codes, { institutional: codes.map((c) => inst(c, 1, 1)) });
    const result = rankUniverse(buildUniverse(codes.map(entry)), ctx);
    const inactive = result.inactiveFactors.find(
      (f) => f.factorKey === 'short_term_reversal_5d_v1',
    );
    expect(inactive).toBeDefined();
    expect(inactive!.reason).toContain('需要 6 個交易日');
    expect(result.activeFactors).not.toContain('short_term_reversal_5d_v1');
  });

  it('滿 6 個交易日後啟用，數值為 close[t]/close[t-5]-1', () => {
    const history = historyWith({
      '1101': [100, 101, 102, 103, 104, 110], // +10%
      '1102': [100, 99, 98, 97, 96, 90], // -10%
    });
    const ctx = buildFactorContext({
      dataAsOf: DAY,
      quotes: history[5]!.quotes,
      institutional: [],
      margin: [],
      monthlyRevenue: [],
      history,
    });
    const result = rankUniverse(
      buildUniverse(codes.map(entry)),
      ctx,
      V1_FACTORS.filter((f) => f.factorKey === 'short_term_reversal_5d_v1'),
    );
    expect(result.activeFactors).toEqual(['short_term_reversal_5d_v1']);
    const s1101 = result.ranked.find((s) => s.code === '1101')!.factorScores[0]!;
    expect(s1101.rawValue).toBeCloseTo(0.1, 12);
    // lower_is_better：跌 10% 的 1102 排第一
    expect(result.ranked[0]!.code).toBe('1102');
  });

  it('回溯期間內有除權息註記者，該檔當期排除（報酬不可直接比較）', () => {
    const history = historyWith(
      { '1101': [100, 101, 102, 103, 104, 110], '1102': [100, 99, 98, 97, 96, 90] },
      ['1101', 3],
    );
    const ctx = buildFactorContext({
      dataAsOf: DAY,
      quotes: history[5]!.quotes,
      institutional: [],
      margin: [],
      monthlyRevenue: [],
      history,
    });
    const result = rankUniverse(
      buildUniverse(codes.map(entry)),
      ctx,
      V1_FACTORS.filter((f) => f.factorKey === 'short_term_reversal_5d_v1'),
    );
    expect(result.coverage['short_term_reversal_5d_v1']).toBe(1);
    expect(result.ranked.map((s) => s.code)).toEqual(['1102']);
  });

  it('回溯期間內缺一天的股票直接排除，不會偷偷用更早的日子湊滿 6 筆', () => {
    // 1101 在 index 2 停牌。若實作只把「有值的日子」串起來，
    // 就會拿 2026-08-06 之前的價格湊數，區間變成 7 個交易日而不報錯。
    const extended = ['2026-08-05', ...dates];
    const history = extended.map((date, i) => ({
      date,
      quotes: [
        ...(i === 3 ? [] : [quote('1101', 100 + i, { date })]),
        quote('1102', 200 - i, { date }),
      ],
    }));
    const ctx = buildFactorContext({
      dataAsOf: DAY,
      quotes: history[6]!.quotes,
      institutional: [],
      margin: [],
      monthlyRevenue: [],
      history,
    });
    const result = rankUniverse(
      buildUniverse(codes.map(entry)),
      ctx,
      V1_FACTORS.filter((f) => f.factorKey === 'short_term_reversal_5d_v1'),
    );
    expect(result.coverage['short_term_reversal_5d_v1']).toBe(1);
    expect(result.ranked.map((s) => s.code)).toEqual(['1102']);
  });
});

// ── 月營收選期（防前視偏誤） ─────────────────────────────────────────────────

describe('selectLatestRevenue', () => {
  it('尚未公布的期別一律不得使用（reportDate 晚於當日）', () => {
    const rows = [
      revenue('1101', '2026-06', '2026-07-10', 5),
      revenue('1101', '2026-07', '2026-08-20', 50), // 8/20 才公布，8/15 不得知
    ];
    const picked = selectLatestRevenue(rows, '2026-08-15');
    expect(picked.get('1101')!.period).toBe('2026-06');
    expect(picked.get('1101')!.yoyPct).toBe(5);
  });

  it('已公布者取期別最新的一筆', () => {
    const rows = [
      revenue('1101', '2026-06', '2026-07-10', 5),
      revenue('1101', '2026-07', '2026-08-10', 50),
    ];
    expect(selectLatestRevenue(rows, '2026-08-15').get('1101')!.period).toBe('2026-07');
  });

  it('同期別有更正時取較晚的出表日', () => {
    const rows = [
      revenue('1101', '2026-07', '2026-08-10', 50),
      revenue('1101', '2026-07', '2026-08-12', 48),
    ];
    expect(selectLatestRevenue(rows, '2026-08-15').get('1101')!.yoyPct).toBe(48);
  });
});

// ── 排序穩定性與觀察榜 ───────────────────────────────────────────────────────

describe('排序與觀察榜', () => {
  it('分數平手時以代號升冪決勝，與輸入順序無關', () => {
    const codes = ['1103', '1101', '1102'];
    const ctx = contextFor(codes, { institutional: codes.map((c) => inst(c, 100, 100)) });
    const result = rankUniverse(buildUniverse(codes.map(entry)), ctx);
    // 三檔完全相同 → 全部平手 → 依代號
    expect(result.ranked.map((s) => s.code)).toEqual(['1101', '1102', '1103']);
  });

  it('觀察榜固定取前 5 檔，不足就給實際有的數量', () => {
    const codes = ['1101', '1102', '1103'];
    const ctx = contextFor(codes, { institutional: codes.map((c, i) => inst(c, i * 100, 0)) });
    const result = rankUniverse(buildUniverse(codes.map(entry)), ctx);
    expect(watchlist(result)).toHaveLength(3);
    expect(watchlist(result, 2)).toHaveLength(2);
  });

  it('回報涵蓋率，讓資料稀疏無法被忽略', () => {
    const codes = ['1101', '1102', '1103', '1104'];
    const ctx = contextFor(codes, {
      institutional: [inst('1101', 1, 1), inst('1102', 2, 2)],
      margin: [margin('1101', 100, 110)],
    });
    const result = rankUniverse(buildUniverse(codes.map(entry)), ctx);
    expect(result.coverage['trust_net_buy_ratio_v1']).toBe(2);
    expect(result.coverage['margin_balance_change_v1']).toBe(1);
    expect(result.coverage['rev_yoy_momentum_v1']).toBe(0);
  });
});

// ── 資料日期對齊 ─────────────────────────────────────────────────────────────

describe('資料日期對齊', () => {
  it('日期對不上就拒絕計算，而不是混著算', () => {
    expect(() =>
      alignDataAsOf('2026-08-15', [
        { label: '上市行情', actual: '2026-08-15' },
        { label: '上櫃行情', actual: '2026-08-14' },
      ]),
    ).toThrow(DataAsOfMismatchError);
  });

  it('全部一致就通過', () => {
    expect(() =>
      alignDataAsOf('2026-08-15', [{ label: '上市行情', actual: '2026-08-15' }]),
    ).not.toThrow();
  });

  it('歷史序列的最後一天必須就是基準日', () => {
    expect(() =>
      buildFactorContext({
        dataAsOf: DAY,
        quotes: [],
        institutional: [],
        margin: [],
        monthlyRevenue: [],
        history: [{ date: '2026-08-14', quotes: [] }],
      }),
    ).toThrow('與基準日');
  });

  it('歷史序列必須升冪且無重複日期', () => {
    expect(() =>
      buildFactorContext({
        dataAsOf: DAY,
        quotes: [],
        institutional: [],
        margin: [],
        monthlyRevenue: [],
        history: [
          { date: '2026-08-14', quotes: [] },
          { date: '2026-08-14', quotes: [] },
          { date: DAY, quotes: [] },
        ],
      }),
    ).toThrow('升冪');
  });
});
