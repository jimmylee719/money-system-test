import { describe, expect, it } from 'vitest';
import {
  NO_ADJUSTMENT,
  adjustmentFor,
  groupByCode,
  mergeEvents,
  normalizeTpexExRight,
  normalizeTpexExRightCheck,
  normalizeTwseExRight,
  rawReturn,
  referencePrice,
  totalReturn,
} from '../exright';
import type { ExRightEvent } from '../exright';

function event(over: Partial<ExRightEvent> = {}): ExRightEvent {
  return {
    code: '2330',
    market: 'TWSE',
    exDate: '2026-08-20',
    cashDividend: 0,
    stockDividendRatio: 0,
    hasRightsIssue: false,
    kind: '息',
    ...over,
  };
}

describe('官方參考價交叉驗證（2026-08-16 實測資料）', () => {
  it('4123 晟德：除權息，配股率 0.0499055、現金股利 1.74669', () => {
    // 官方公告：前收 34.30 → 參考價 31.01
    // 這一檔是關鍵案例：若誤把上櫃計算結果表的 StockDividend（1.547368，權值元數）
    // 當成配股率，會算出 12.78，差了兩倍以上。
    const price = referencePrice(34.3, 1.74669389, 0.04990554083);
    expect(price).toBeCloseTo(31.0059, 3);
    // 官方參考價 31.01 是跳動單位進位後的結果，誤差應在一個 tick 內
    expect(Math.abs(price - 31.01)).toBeLessThan(0.01);
  });

  it('4162 智擎：純除息 2 元，前收 62.1 → 參考價 60.1', () => {
    expect(referencePrice(62.1, 2, 0)).toBeCloseTo(60.1, 10);
  });

  it('00844B：純除息 0.41，前收 31.34 → 參考價 30.93', () => {
    expect(referencePrice(31.34, 0.41, 0)).toBeCloseTo(30.93, 10);
  });

  it('誤把權值當配股率會得到明顯錯誤的答案（記錄這個陷阱）', () => {
    const wrong = referencePrice(34.3, 1.74669389, 1.547368);
    expect(wrong).toBeCloseTo(12.78, 1);
    expect(Math.abs(wrong - 31.01)).toBeGreaterThan(18);
  });
});

describe('持有期間還原', () => {
  it('期間內無事件 → 不調整', () => {
    const adj = adjustmentFor([event({ exDate: '2026-09-01' })], '2026-08-14', '2026-08-21');
    expect(adj).toEqual(NO_ADJUSTMENT);
  });

  it('純除息：報酬要把股利加回來', () => {
    const events = [event({ exDate: '2026-08-18', cashDividend: 2 })];
    const adj = adjustmentFor(events, '2026-08-14', '2026-08-28');
    expect(adj.shareFactor).toBe(1);
    expect(adj.cashPerOriginalShare).toBe(2);

    // 進場 100，出場 99（帳面 −1%），但期間配息 2 元 → 實際 +1%
    expect(rawReturn(100, 99)).toBeCloseTo(-0.01, 10);
    expect(totalReturn(100, 99, adj)).toBeCloseTo(0.01, 10);
  });

  it('純除權：報酬要把增加的股數算進來', () => {
    const events = [event({ exDate: '2026-08-18', stockDividendRatio: 0.1 })];
    const adj = adjustmentFor(events, '2026-08-14', '2026-08-28');
    expect(adj.shareFactor).toBeCloseTo(1.1, 10);

    // 進場 110，出場 100（帳面 −9.09%），但股數變 1.1 倍 → 實際 0%
    expect(totalReturn(110, 100, adj)).toBeCloseTo(0, 10);
  });

  it('權息並存（4123 晟德的實際數字）', () => {
    const events = [
      event({
        code: '4123',
        market: 'TPEx',
        exDate: '2026-08-17',
        cashDividend: 1.74669389,
        stockDividendRatio: 0.04990554083,
        kind: '除權息',
      }),
    ];
    const adj = adjustmentFor(events, '2026-08-14', '2026-08-31');

    // 進場 34.30、出場恰為參考價 31.0059 → 含息總報酬應為 0
    const ref = referencePrice(34.3, 1.74669389, 0.04990554083);
    expect(totalReturn(34.3, ref, adj)).toBeCloseTo(0, 9);
    // 未還原的話會看起來跌了 9.6%
    expect(rawReturn(34.3, ref)).toBeCloseTo(-0.0961, 3);
  });

  it('區間左開右閉：進場日當天的除權息不再還原一次', () => {
    // 進場日 8/14 當天除權息 → 進場價已是除權息後的價格
    const events = [event({ exDate: '2026-08-14', cashDividend: 5 })];
    expect(adjustmentFor(events, '2026-08-14', '2026-08-28')).toEqual(NO_ADJUSTMENT);
  });

  it('區間左開右閉：出場日當天的除權息要還原', () => {
    const events = [event({ exDate: '2026-08-28', cashDividend: 5 })];
    const adj = adjustmentFor(events, '2026-08-14', '2026-08-28');
    expect(adj.cashPerOriginalShare).toBe(5);
  });

  it('多次除權息：後面的現金股利適用已增加的股數', () => {
    const events = [
      event({ exDate: '2026-08-18', stockDividendRatio: 0.1, cashDividend: 1 }),
      event({ exDate: '2026-09-18', cashDividend: 2 }),
    ];
    const adj = adjustmentFor(events, '2026-08-14', '2026-09-30');
    expect(adj.shareFactor).toBeCloseTo(1.1, 10);
    // 第一次配息時仍是 1 股 → 1 元；第二次時已是 1.1 股 → 2 × 1.1 = 2.2
    expect(adj.cashPerOriginalShare).toBeCloseTo(1 + 2.2, 10);
  });

  it('事件順序顛倒輸入也算得對（內部會排序）', () => {
    const a = adjustmentFor(
      [
        event({ exDate: '2026-09-18', cashDividend: 2 }),
        event({ exDate: '2026-08-18', stockDividendRatio: 0.1, cashDividend: 1 }),
      ],
      '2026-08-14',
      '2026-09-30',
    );
    expect(a.cashPerOriginalShare).toBeCloseTo(3.2, 10);
  });

  it('現金增資只標記不還原（沒認購的人確實被稀釋）', () => {
    const events = [event({ exDate: '2026-08-18', hasRightsIssue: true })];
    const adj = adjustmentFor(events, '2026-08-14', '2026-08-28');
    expect(adj.hasRightsIssue).toBe(true);
    expect(adj.shareFactor).toBe(1);
    expect(adj.cashPerOriginalShare).toBe(0);
  });

  it('進場價非正數時拋錯', () => {
    expect(() => totalReturn(0, 100, NO_ADJUSTMENT)).toThrow(RangeError);
    expect(() => rawReturn(-1, 100)).toThrow(RangeError);
  });
});

describe('正規化（用實測回應的欄位名）', () => {
  it('上市：Exdividend 小寫 d、SubscriptionRatio 判定現金增資', () => {
    const events = normalizeTwseExRight([
      {
        Date: '1150818',
        Code: '2364',
        Name: '倫飛',
        Exdividend: '權息',
        StockDividendRatio: '0.10000000',
        SubscriptionRatio: '',
        SubscriptionPricePerShare: '',
        CashDividend: '2.000000',
      },
    ]);
    expect(events).toEqual([
      {
        code: '2364',
        market: 'TWSE',
        exDate: '2026-08-18',
        cashDividend: 2,
        stockDividendRatio: 0.1,
        hasRightsIssue: false,
        kind: '權息',
      },
    ]);
  });

  it('上櫃：日期欄位是 ExRrightsExDividendDate（兩個 r）', () => {
    const events = normalizeTpexExRight([
      {
        ExRrightsExDividendDate: '1150817',
        SecuritiesCompanyCode: '4123',
        CompanyName: '晟德',
        ExRrightsExDividend: '除權息',
        StockDividendRatio: '0.04990554',
        SubscriptionRatioToNewSharesIssued: '0.00000000',
        CashDividend: '1.74669389',
      },
    ]);
    expect(events[0]).toMatchObject({
      code: '4123',
      market: 'TPEx',
      exDate: '2026-08-17',
      cashDividend: 1.74669389,
      stockDividendRatio: 0.04990554,
    });
  });

  it('上櫃計算結果表：配股率取自 StockDivdendThousandShares ÷ 1000，不是 StockDividend', () => {
    const rows = normalizeTpexExRightCheck([
      {
        Date: '1150817',
        SecuritiesCompanyCode: '4123',
        ClosePriceBeforeExRightsDiviend: '34.30',
        ExRightsDiviendQuote: '31.01',
        StockDividend: '1.547368', // 權值（元），**不是**配股率
        CashDividend: '1.746694',
        CashDivdend: '1.74669389',
        StockDivdendThousandShares: '49.90554083',
      },
    ]);
    expect(rows[0]!.stockDividendRatio).toBeCloseTo(0.04990554, 8);
    expect(rows[0]!.cashDividend).toBeCloseTo(1.74669389, 8);
    // 用抽出來的值重算，應該還原出官方參考價
    const price = referencePrice(
      rows[0]!.closeBefore,
      rows[0]!.cashDividend,
      rows[0]!.stockDividendRatio,
    );
    expect(Math.abs(price - rows[0]!.officialReferencePrice)).toBeLessThan(0.01);
  });

  it('缺代號或日期無法解析的列直接略過，不猜', () => {
    expect(normalizeTwseExRight([{ Date: '', Code: '2330' }])).toEqual([]);
    expect(normalizeTwseExRight([{ Date: '1150818', Code: '' }])).toEqual([]);
  });

  it('空字串欄位視為 0，不是 NaN', () => {
    const events = normalizeTwseExRight([
      { Date: '1150818', Code: '1453', Exdividend: '權', StockDividendRatio: '0.03', CashDividend: '' },
    ]);
    expect(events[0]!.cashDividend).toBe(0);
    expect(events[0]!.stockDividendRatio).toBe(0.03);
  });
});

describe('跨快照合併', () => {
  it('同一事件重複出現時保留最後一版（公司可能更正股利）', () => {
    const merged = mergeEvents([
      [event({ code: '2330', exDate: '2026-08-20', cashDividend: 3 })],
      [event({ code: '2330', exDate: '2026-08-20', cashDividend: 3.5 })],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.cashDividend).toBe(3.5);
  });

  it('不同代號或不同日期視為不同事件', () => {
    const merged = mergeEvents([
      [event({ code: '2330', exDate: '2026-08-20' })],
      [event({ code: '2317', exDate: '2026-08-20' })],
      [event({ code: '2330', exDate: '2027-08-20' })],
    ]);
    expect(merged).toHaveLength(3);
  });

  it('依日期升冪排序', () => {
    const merged = mergeEvents([
      [event({ exDate: '2026-09-01' }), event({ exDate: '2026-08-01', code: '1101' })],
    ]);
    expect(merged.map((e) => e.exDate)).toEqual(['2026-08-01', '2026-09-01']);
  });

  it('groupByCode 依代號分組', () => {
    const grouped = groupByCode([
      event({ code: '2330', exDate: '2026-08-20' }),
      event({ code: '2330', exDate: '2027-08-20' }),
      event({ code: '2317', exDate: '2026-08-20' }),
    ]);
    expect(grouped.get('2330')).toHaveLength(2);
    expect(grouped.get('2317')).toHaveLength(1);
  });
});
