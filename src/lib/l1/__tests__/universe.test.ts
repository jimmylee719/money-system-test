import { describe, expect, it } from 'vitest';
import {
  normalizeTpexCompanyProfile,
  normalizeTpexQuotes,
  normalizeTwseCompanyProfile,
  normalizeTwseQuotes,
} from '../normalize';
import {
  buildUniverse,
  filterToUniverse,
  isTradable,
  mergeUniverses,
  summarizeUniverse,
} from '../universe';
import type { DailyQuote } from '../types';

/** 取自 2026-08-16 實測資料的代表性樣本 */
const TWSE_PROFILE = [
  { 公司代號: '1101', 公司簡稱: '台泥', 產業別: '01', 上市日期: '19620209', 實收資本額: '77231817420', '已發行普通股數或TDR原股發行股數': '7723181742' },
  { 公司代號: '2330', 公司簡稱: '台積電', 產業別: '24', 上市日期: '19940905', 實收資本額: '259303804580', '已發行普通股數或TDR原股發行股數': '25930380458' },
  // 第一上市外國公司：6 碼代號。用「4 碼數字」正則會漏掉它
  { 公司代號: '910322', 公司簡稱: '康師傅-DR', 產業別: '20', 上市日期: '20090116', 實收資本額: '0', '已發行普通股數或TDR原股發行股數': '0' },
];

const TWSE_QUOTES = [
  { Date: '1150814', Code: '1101', Name: '台泥', TradeVolume: '10000', TradeValue: '200000', OpeningPrice: '20.00', HighestPrice: '20.10', LowestPrice: '19.90', ClosingPrice: '20.05', Change: '0.0500', Transaction: '30' },
  { Date: '1150814', Code: '2330', Name: '台積電', TradeVolume: '20000', TradeValue: '2000000', OpeningPrice: '1000', HighestPrice: '1010', LowestPrice: '995', ClosingPrice: '1005', Change: '-5.0000', Transaction: '50' },
  { Date: '1150814', Code: '910322', Name: '康師傅-DR', TradeVolume: '500', TradeValue: '5000', OpeningPrice: '10', HighestPrice: '10', LowestPrice: '10', ClosingPrice: '10', Change: '0', Transaction: '3' },
  // ETF：4 碼純數字但不是公司，必須被排除
  { Date: '1150814', Code: '0050', Name: '元大台灣50', TradeVolume: '99999', TradeValue: '9999999', OpeningPrice: '200', HighestPrice: '201', LowestPrice: '199', ClosingPrice: '200', Change: '1', Transaction: '999' },
  // 權證：6 碼，必須被排除
  { Date: '1150814', Code: '030001', Name: '某某購01', TradeVolume: '1000', TradeValue: '1000', OpeningPrice: '1', HighestPrice: '1', LowestPrice: '1', ClosingPrice: '1', Change: '0', Transaction: '1' },
];

const TPEX_PROFILE = [
  { Date: '1150815', SecuritiesCompanyCode: '1240', CompanyAbbreviation: '茂生農經', SecuritiesIndustryCode: '33', DateOfListing: '20180808', 'Paidin.Capital.NTDollars': '500000000', IssueShares: '50000000' },
];

const TPEX_QUOTES = [
  { Date: '1150814', SecuritiesCompanyCode: '1240', CompanyName: '茂生農經', Close: '45.00', Change: '-0.72 ', Open: '45.5', High: '46', Low: '44.8', Average: '45.4', TradingShares: '10000', TransactionAmount: '450000', TransactionNumber: '20' },
  // 上櫃行情表 10,489 列中有 9,141 列是權證，且多數當日無成交
  { Date: '1150814', SecuritiesCompanyCode: '706001', CompanyName: '某權證', Close: ' ---', Change: '0.00', Open: ' ---', High: ' ---', Low: ' ---', Average: ' ---', TradingShares: '0', TransactionAmount: '0', TransactionNumber: '0' },
];

describe('標的池以公司名冊為準，不用代號正則', () => {
  const twse = buildUniverse(normalizeTwseCompanyProfile(TWSE_PROFILE).rows);
  const tpex = buildUniverse(normalizeTpexCompanyProfile(TPEX_PROFILE).rows);

  it('收錄 6 碼代號的第一上市外國公司', () => {
    // 「4 碼數字」正則會把這檔漏掉
    expect(twse.byCode.has('910322')).toBe(true);
    expect(twse.size).toBe(3);
  });

  it('排除 ETF 與權證 —— 它們不在公司名冊裡', () => {
    const quotes = normalizeTwseQuotes(TWSE_QUOTES, '2026-08-14').rows;
    const filtered = filterToUniverse(twse, quotes);

    expect(filtered.kept.map((q) => q.code).sort()).toEqual(['1101', '2330', '910322']);
    // 0050（4 碼數字的 ETF）與 030001（權證）都被排除
    expect(filtered.excluded).toBe(2);
    expect(filtered.kept.map((q) => q.code)).not.toContain('0050');
  });

  it('回報名冊上有但當日資料裡沒有的代號，不靜默忽略', () => {
    const quotes = normalizeTwseQuotes(TWSE_QUOTES.slice(0, 1), '2026-08-14').rows;
    const filtered = filterToUniverse(twse, quotes);
    expect(filtered.missingFromData).toEqual(['2330', '910322']);
  });

  it('可合併上市與上櫃名冊', () => {
    const all = mergeUniverses(twse, tpex);
    expect(all.size).toBe(4);
    expect(all.byCode.get('1240')?.market).toBe('TPEx');
    expect(all.byCode.get('1101')?.market).toBe('TWSE');
  });

  it('保留產業別與上市日期供後續分群使用', () => {
    expect(twse.byCode.get('2330')).toMatchObject({
      name: '台積電',
      industryCode: '24',
      listingDate: '1994-09-05',
    });
  });
});

describe('isTradable —— 事實判定，不是投資判斷', () => {
  const base: DailyQuote = {
    code: 'X',
    market: 'TWSE',
    date: '2026-08-14',
    open: 10,
    high: 10,
    low: 10,
    close: 10,
    change: 0,
    changeNote: null,
    volumeShares: 1000,
    turnoverValue: 10000,
    transactions: 5,
  };

  it('有收盤價且有成交量才算有成交', () => {
    expect(isTradable(base)).toBe(true);
    expect(isTradable({ ...base, close: null })).toBe(false);
    expect(isTradable({ ...base, volumeShares: 0 })).toBe(false);
    expect(isTradable({ ...base, volumeShares: null })).toBe(false);
    expect(isTradable({ ...base, close: 0 })).toBe(false);
  });

  it('上櫃「 ---」（當日無成交）解析後不可交易', () => {
    const quotes = normalizeTpexQuotes(TPEX_QUOTES, '2026-08-14').rows;
    const warrant = quotes.find((q) => q.code === '706001');
    expect(warrant?.close).toBe(null);
    expect(isTradable(warrant!)).toBe(false);
  });
});

describe('summarizeUniverse', () => {
  it('一次回報名冊大小、有行情者、可交易者與被排除者', () => {
    const twse = buildUniverse(normalizeTwseCompanyProfile(TWSE_PROFILE).rows);
    const quotes = normalizeTwseQuotes(TWSE_QUOTES, '2026-08-14').rows;
    expect(summarizeUniverse(twse, quotes, 'TWSE')).toEqual({
      market: 'TWSE',
      universeSize: 3,
      withQuote: 3,
      tradable: 3,
      excludedFromQuotes: 2,
    });
  });
});
