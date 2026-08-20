import { describe, expect, it } from 'vitest';
import type { RankedStock, RankingResult } from '../factors/engine';
import { buildPickRows } from '../picks';
import type { TradeSignalFields } from '../picks';

function stock(code: string, close: number): RankedStock {
  return {
    code,
    market: 'TWSE',
    name: `公司${code}`,
    close,
    compositeScore: 0.9,
    realFactorCount: 3,
    factorScores: [],
    // 排序無關，僅供顯示；預設不帶行情細節
    change: null,
    changeNote: null,
    volumeShares: null,
    turnoverValue: null,
  };
}

const RESULT: RankingResult = {
  dataAsOf: '2026-08-17',
  engineVersion: 'l1-equal-weight-rank-v1',
  activeFactors: ['trust_net_buy_ratio_v1'],
  inactiveFactors: [],
  universeSize: 1985,
  tradableCount: 1960,
  rankedCount: 1898,
  excludedNoFactorData: 62,
  coverage: {},
  ranked: [],
};

const FIELDS: TradeSignalFields = {
  entryPrice: 20,
  stopPrice: 18.5,
  takeProfitPrice: 23,
  timeExitDays: 10,
  lots: 7,
  shares: 7000,
  positionValueTwd: 140_000,
  riskAmountTwd: 10_000,
  sigmaDaily: 0.01,
  volObservations: 25,
  equityAtSignalTwd: 1_000_000,
  riskConfigVersion: 'risk-v1',
  riskConfigHash: 'a'.repeat(64),
};

const BASE = {
  result: RESULT,
  runId: '00000000-0000-4000-8000-000000000000',
  revision: 1,
  signalAt: '2026-08-17T10:40:00.000Z',
};

describe('buildPickRows', () => {
  it('名次由清單位置決定，呼叫端無法自行指定', () => {
    const rows = buildPickRows({
      ...BASE,
      stocks: [stock('1101', 20), stock('1102', 30)],
      listKind: 'watchlist',
    });
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(rows[0]!.code).toBe('1101');
  });

  it('觀察榜完全不帶屏障欄位（帶了會被資料庫 constraint 擋下）', () => {
    const rows = buildPickRows({
      ...BASE,
      stocks: [stock('1101', 20)],
      listKind: 'watchlist',
    });
    expect(rows[0]!.entry_price).toBeUndefined();
    expect(rows[0]!.stop_price).toBeUndefined();
    expect(rows[0]!.risk_config_hash).toBeUndefined();
  });

  it('交易訊號帶齊三道屏障與部位', () => {
    const rows = buildPickRows({
      ...BASE,
      stocks: [stock('1101', 20)],
      listKind: 'trade_signal',
      signalFields: new Map([['1101', FIELDS]]),
    });
    const row = rows[0]!;
    expect(row.entry_price).toBe(20);
    expect(row.stop_price).toBe(18.5);
    expect(row.take_profit_price).toBe(23);
    expect(row.time_exit_days).toBe(10);
    expect(row.lots).toBe(7);
    // 當時的資金必須留存，否則日後無法還原部位是怎麼算出來的
    expect(row.equity_at_signal_twd).toBe(1_000_000);
    expect(row.risk_config_hash).toBe('a'.repeat(64));
  });

  it('交易訊號缺屏障資料時直接拋錯，不會寫出一筆沒有停損的訊號', () => {
    expect(() =>
      buildPickRows({
        ...BASE,
        stocks: [stock('1101', 20), stock('1102', 30)],
        listKind: 'trade_signal',
        signalFields: new Map([['1101', FIELDS]]), // 少了 1102
      }),
    ).toThrow(/1102 缺少屏障與部位資料/);
  });

  it('完全沒給 signalFields 時也拋錯', () => {
    expect(() =>
      buildPickRows({ ...BASE, stocks: [stock('1101', 20)], listKind: 'trade_signal' }),
    ).toThrow(/不是訊號/);
  });

  it('price_at_push 取自當日收盤，日後算報酬的基準不可事後調整', () => {
    const rows = buildPickRows({
      ...BASE,
      stocks: [stock('1101', 47.35)],
      listKind: 'watchlist',
    });
    expect(rows[0]!.price_at_push).toBe(47.35);
  });
});
