import { describe, expect, it } from 'vitest';
import {
  normalizeMonthlyRevenue,
  normalizeTpexInstitutional,
  normalizeTpexQuotes,
  normalizeTwseInstitutional,
  normalizeTwseValuation,
  rowsFromRwdTable,
} from '../normalize';

describe('rowsFromRwdTable —— TWSE 網站端點的 {fields,data} 形狀', () => {
  const payload = {
    stat: 'OK',
    date: '20260814',
    fields: ['證券代號', '證券名稱', '三大法人買賣超股數'],
    data: [
      ['1101', '台泥', '5,678,900'],
      ['2330', '台積電', '-1,234,567'],
    ],
  };

  it('用官方給的 fields 當欄位名，不改名', () => {
    const rows = rowsFromRwdTable(payload);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ 證券代號: '1101', 證券名稱: '台泥', 三大法人買賣超股數: '5,678,900' });
  });

  it('缺少 fields 或 data 時回空陣列而非拋錯', () => {
    expect(rowsFromRwdTable({ stat: '很抱歉，沒有符合條件的資料!' })).toEqual([]);
    expect(rowsFromRwdTable(null)).toEqual([]);
    expect(rowsFromRwdTable([])).toEqual([]);
  });
});

describe('normalizeTwseInstitutional', () => {
  const payload = {
    date: '20260814',
    fields: [
      '證券代號',
      '證券名稱',
      '外陸資買賣超股數(不含外資自營商)',
      '投信買賣超股數',
      '自營商買賣超股數',
      '三大法人買賣超股數',
    ],
    data: [
      ['1101', '台泥', '1,000,000', '200,000', '-50,000', '1,150,000'],
      ['2330', '台積電', '-3,000,000', '0', '500,000', '-2,500,000'],
    ],
  };

  it('解析千分位逗號與負數', () => {
    const r = normalizeTwseInstitutional(payload, '2026-08-14');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toEqual({
      code: '1101',
      market: 'TWSE',
      date: '2026-08-14',
      foreignNet: 1000000,
      trustNet: 200000,
      dealerNet: -50000,
      totalNet: 1150000,
    });
    expect(r.rows[1]?.foreignNet).toBe(-3000000);
    expect(r.stats.unparsable).toBe(0);
  });

  it('日期由呼叫端傳入（來自 L0 的 data_as_of），不從 payload 重判', () => {
    const r = normalizeTwseInstitutional(payload, '2026-08-14');
    expect(r.rows.every((row) => row.date === '2026-08-14')).toBe(true);
  });
});

describe('normalizeTpexInstitutional —— 官方欄位名含空格與不一致分隔', () => {
  const payload = [
    {
      Date: '1150814',
      SecuritiesCompanyCode: '1240',
      CompanyName: '茂生農經',
      'Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Difference': '-3564723',
      'SecuritiesInvestmentTrustCompanies-Difference': '12000',
      'Dealers-Difference': '-500',
      TotalDifference: '-3553223',
    },
  ];

  it('逐字使用官方欄位名，不做「順手修正」', () => {
    const r = normalizeTpexInstitutional(payload, '2026-08-14');
    expect(r.rows[0]).toEqual({
      code: '1240',
      market: 'TPEx',
      date: '2026-08-14',
      foreignNet: -3564723,
      trustNet: 12000,
      dealerNet: -500,
      totalNet: -3553223,
    });
  });
});

describe('normalizeTwseValuation —— 缺值不得代換為 0', () => {
  const payload = [
    { Date: '1150814', Code: '1101', Name: '台泥', PEratio: '', DividendYield: '3.30', PBratio: '0.79' },
    { Date: '1150814', Code: '1102', Name: '亞泥', PEratio: '9.24', DividendYield: '6.88', PBratio: '0.64' },
  ];

  it('虧損公司的空字串本益比解析為 null', () => {
    const r = normalizeTwseValuation(payload, '2026-08-14');
    // 沒有本益比 ≠ 本益比為 0。代換為 0 會讓它在「本益比越低越好」的排序裡排第一
    expect(r.rows[0]?.peRatio).toBe(null);
    expect(r.rows[0]?.dividendYield).toBe(3.3);
    expect(r.rows[1]?.peRatio).toBe(9.24);
    expect(r.stats.blank).toBe(1);
    expect(r.stats.unparsable).toBe(0);
  });
});

describe('normalizeTpexQuotes —— 當日無成交的「 ---」', () => {
  const payload = [
    {
      SecuritiesCompanyCode: '706001',
      Close: ' ---',
      Change: '0.00',
      Open: ' ---',
      High: ' ---',
      Low: ' ---',
      TradingShares: '0',
      TransactionAmount: '0',
      TransactionNumber: '0',
    },
  ];

  it('價格解析為 null、成交量為 0，不混為一談', () => {
    const r = normalizeTpexQuotes(payload, '2026-08-14');
    expect(r.rows[0]?.close).toBe(null);
    expect(r.rows[0]?.volumeShares).toBe(0);
    expect(r.stats.unparsable).toBe(0);
  });
});

describe('normalizeMonthlyRevenue —— 報表日與資料期間必須分開', () => {
  const payload = [
    {
      出表日期: '1150815',
      資料年月: '11507',
      公司代號: '1101',
      公司名稱: '台泥',
      '營業收入-當月營收': '13744103',
      '營業收入-去年同月增減(%)': '1.5379365538929763',
      '營業收入-上月比較增減(%)': '2.70047776585692',
    },
  ];

  it('reportDate 是最早可知時點，period 是營收所屬月份', () => {
    const r = normalizeMonthlyRevenue(payload, 'TWSE', '2026-08-15', '2026-07');
    expect(r.rows[0]).toEqual({
      code: '1101',
      market: 'TWSE',
      // 8/15 才公布 7 月的數字。用 period 當可知時點就是前視偏誤
      reportDate: '2026-08-15',
      period: '2026-07',
      revenue: 13744103,
      yoyPct: 1.5379365538929763,
      momPct: 2.70047776585692,
    });
    expect(r.rows[0]?.reportDate).not.toBe(r.rows[0]?.period);
  });
});

describe('被略過的列一定要統計', () => {
  it('沒有代號的列被記錄，不靜默丟棄', () => {
    const r = normalizeTwseValuation([{ Code: '', PEratio: '1' }, { Code: '1101', PEratio: '2' }], '2026-08-14');
    expect(r.sourceRowCount).toBe(2);
    expect(r.rows).toHaveLength(1);
    expect(r.skipped).toEqual({ missing_code: 1 });
  });
});
