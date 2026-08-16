import { describe, expect, it } from 'vitest';
import type { ExRightEvent } from '../exright';
import { HORIZONS, adjustBarrier, computeAllHorizons, computeOutcome, scanBarriers } from '../outcomes';
import type { DailyBar, OutcomeInput } from '../outcomes';

/** 產生連續 n 個交易日（刻意跳過週末，證明用的是序列而非日曆） */
const DATES = [
  '2026-08-14',
  '2026-08-17',
  '2026-08-18',
  '2026-08-19',
  '2026-08-20',
  '2026-08-21',
  '2026-08-24',
  '2026-08-25',
  '2026-08-26',
  '2026-08-27',
  '2026-08-28',
];

function bars(closes: readonly (number | null)[], spread = 0): Map<string, DailyBar> {
  const map = new Map<string, DailyBar>();
  closes.forEach((close, i) => {
    const date = DATES[i]!;
    map.set(date, {
      date,
      close,
      high: close === null ? null : close + spread,
      low: close === null ? null : close - spread,
    });
  });
  return map;
}

function input(over: Partial<OutcomeInput> = {}): OutcomeInput {
  return {
    signalDate: '2026-08-14',
    entryPrice: 100,
    tradingDates: DATES,
    barsByDate: bars([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110]),
    exRightEvents: [],
    barriers: null,
    ...over,
  };
}

describe('T+N 用交易日序列，不是日曆日', () => {
  it('T+5 的出場日是序列上的第 5 個交易日（跨越週末）', () => {
    const r = computeOutcome(input(), 5);
    // 8/14 之後第 5 個交易日是 8/21（8/15、8/16 是週末，序列裡沒有）
    expect(r.exitDate).toBe('2026-08-21');
    expect(r.status).toBe('computed');
    expect(r.tradingDaysUsed).toBe(5);
  });

  it('交易日不足時回 not_mature，不算一半', () => {
    const r = computeOutcome(input({ tradingDates: DATES.slice(0, 4) }), 5);
    expect(r.status).toBe('not_mature');
    expect(r.adjustedReturnPct).toBeNull();
    expect(r.exitDate).toBeNull();
  });

  it('訊號日不在序列中時也回 not_mature', () => {
    const r = computeOutcome(input({ signalDate: '2026-01-01' }), 5);
    expect(r.status).toBe('not_mature');
  });

  it('三個觀察期一次算完', () => {
    const results = computeAllHorizons(input());
    expect(results.map((r) => r.horizon)).toEqual([...HORIZONS]);
    expect(results[0]!.status).toBe('computed'); // T+5
    expect(results[1]!.status).toBe('computed'); // T+10
    expect(results[2]!.status).toBe('not_mature'); // T+20，序列只有 10 天
  });
});

describe('報酬計算', () => {
  it('無除權息時，還原報酬等於帳面報酬', () => {
    const r = computeOutcome(input(), 5);
    expect(r.exitPrice).toBe(105);
    expect(r.rawReturnPct).toBeCloseTo(5, 10);
    expect(r.adjustedReturnPct).toBeCloseTo(5, 10);
    expect(r.exRightCount).toBe(0);
  });

  it('期間除息：帳面看起來沒漲，還原後其實有賺', () => {
    const events: ExRightEvent[] = [
      {
        code: '2330',
        market: 'TWSE',
        exDate: '2026-08-19',
        cashDividend: 3,
        stockDividendRatio: 0,
        hasRightsIssue: false,
        kind: '息',
      },
    ];
    // 除息 3 元後價格原地不動 → 帳面 0%，實際 +3%
    const r = computeOutcome(
      input({ barsByDate: bars([100, 100, 100, 100, 100, 100]), exRightEvents: events }),
      5,
    );
    expect(r.rawReturnPct).toBeCloseTo(0, 10);
    expect(r.adjustedReturnPct).toBeCloseTo(3, 10);
    expect(r.cashDividendPerShare).toBe(3);
    expect(r.exRightCount).toBe(1);
  });

  it('出場日停牌沒有價格 → no_price_at_exit，不硬算', () => {
    const r = computeOutcome(input({ barsByDate: bars([100, 101, 102, 103, 104, null]) }), 5);
    expect(r.status).toBe('no_price_at_exit');
    expect(r.adjustedReturnPct).toBeNull();
    expect(r.exitDate).toBe('2026-08-21'); // 日期仍如實記錄
  });
});

describe('屏障觸及', () => {
  const barriers = { stopPrice: 95, takeProfitPrice: 110 };

  it('觸及停損', () => {
    const r = computeOutcome(
      input({ barsByDate: bars([100, 99, 97, 94, 96, 98]), barriers }),
      5,
    );
    expect(r.barrierTouched).toBe('stop');
    expect(r.barrierTouchDate).toBe('2026-08-19');
  });

  it('觸及停利', () => {
    const r = computeOutcome(
      input({ barsByDate: bars([100, 103, 106, 111, 112, 113]), barriers }),
      5,
    );
    expect(r.barrierTouched).toBe('target');
    expect(r.barrierTouchDate).toBe('2026-08-19');
  });

  it('都沒觸及 → 時間出場', () => {
    const r = computeOutcome(
      input({ barsByDate: bars([100, 101, 102, 103, 104, 105]), barriers }),
      5,
    );
    expect(r.barrierTouched).toBe('time');
    expect(r.barrierTouchDate).toBeNull();
  });

  it('同一天同時觸及停損與停利 → 判停損（取最壞情況）', () => {
    // 8/18 當天高 115、低 90，兩個屏障都在當日區間內。
    // 只有日 K 無法得知盤中誰先到，取最壞情況是唯一誠實的做法——
    // 反過來假設先觸停利會系統性高估績效。
    const map = bars([100, 101, 102, 103, 104, 105]);
    map.set('2026-08-18', { date: '2026-08-18', close: 102, high: 115, low: 90 });
    const r = computeOutcome(input({ barsByDate: map, barriers }), 5);
    expect(r.barrierTouched).toBe('stop');
    expect(r.barrierTouchDate).toBe('2026-08-18');
  });

  it('觀察榜沒有屏障 → barrierTouched 為 null', () => {
    const r = computeOutcome(input({ barriers: null }), 5);
    expect(r.barrierTouched).toBeNull();
  });

  it('只看訊號日之後的日子，訊號日當天不算觸及', () => {
    // 訊號日當天低點跌破停損，但那是進場前的事
    const map = bars([100, 101, 102, 103, 104, 105]);
    map.set('2026-08-14', { date: '2026-08-14', close: 100, high: 100, low: 90 });
    const r = computeOutcome(input({ barsByDate: map, barriers }), 5);
    expect(r.barrierTouched).toBe('time');
  });
});

describe('屏障隨除權息調整（否則配息會被誤判成跌破停損）', () => {
  const events: ExRightEvent[] = [
    {
      code: '2330',
      market: 'TWSE',
      exDate: '2026-08-18',
      cashDividend: 6,
      stockDividendRatio: 0,
      hasRightsIssue: false,
      kind: '息',
    },
  ];

  it('adjustBarrier：除息 6 元後，停損價同步下調 6 元', () => {
    expect(adjustBarrier(95, events, '2026-08-14', '2026-08-18')).toBeCloseTo(89, 10);
    // 除權息日之前不調整
    expect(adjustBarrier(95, events, '2026-08-14', '2026-08-17')).toBe(95);
  });

  it('配股時屏障除以 (1+配股率)', () => {
    const stockEvent: ExRightEvent[] = [{ ...events[0]!, cashDividend: 0, stockDividendRatio: 0.1 }];
    expect(adjustBarrier(110, stockEvent, '2026-08-14', '2026-08-18')).toBeCloseTo(100, 10);
  });

  it('除息造成的價格下跌不會誤觸停損', () => {
    // 進場 100、停損 95。除息 6 元後價格變 94——帳面跌破停損，
    // 但那是配息不是下跌，調整後停損是 89，不該觸及。
    const map = bars([100, 100, 94, 94, 94, 94]);
    const r = computeOutcome(
      input({
        barsByDate: map,
        exRightEvents: events,
        barriers: { stopPrice: 95, takeProfitPrice: 110 },
      }),
      5,
    );
    expect(r.barrierTouched).toBe('time');
    // 而且含息報酬其實是 0%（94 + 6 = 100）
    expect(r.adjustedReturnPct).toBeCloseTo(0, 10);
    expect(r.rawReturnPct).toBeCloseTo(-6, 10);
  });

  it('若不調整屏障就會誤判 —— 明確測出這個差異', () => {
    const map = bars([100, 100, 94, 94, 94, 94]);
    const barList = ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21'].map(
      (d) => map.get(d)!,
    );
    // 不帶除權息事件去掃 → 會誤判成停損
    expect(scanBarriers(barList, 95, 110, [], '2026-08-14').touched).toBe('stop');
    // 帶了事件 → 正確判定為未觸及
    expect(scanBarriers(barList, 95, 110, events, '2026-08-14').touched).toBe('none');
  });
});

describe('現金增資標記', () => {
  it('期間內有現金增資會被標記（本系統不認購，不還原）', () => {
    const events: ExRightEvent[] = [
      {
        code: '2330',
        market: 'TWSE',
        exDate: '2026-08-19',
        cashDividend: 0,
        stockDividendRatio: 0,
        hasRightsIssue: true,
        kind: '權',
      },
    ];
    const r = computeOutcome(input({ exRightEvents: events }), 5);
    expect(r.hasRightsIssue).toBe(true);
    expect(r.shareFactor).toBe(1);
  });
});
