import { describe, expect, it } from 'vitest';
import { DATE_PLACEHOLDER, resolveSourceUrl } from '../ingest';
import { TWSE_INSTITUTIONAL_BY_STOCK, TWSE_STOCK_DAY_ALL } from '../sources';
import type { SourceId } from '../types';

describe('resolveSourceUrl — 日期不自行推定', () => {
  it('沒有佔位符的來源原樣通過', () => {
    expect(resolveSourceUrl(TWSE_STOCK_DAY_ALL, new Map())).toEqual({
      url: TWSE_STOCK_DAY_ALL.url,
    });
  });

  it('用來源自己宣告的交易日填入網址，不用系統時鐘', () => {
    const dates = new Map<SourceId, string>([['twse_stock_day_all', '2026-08-14']]);
    const result = resolveSourceUrl(TWSE_INSTITUTIONAL_BY_STOCK, dates);

    expect(result).toEqual({
      url: 'https://www.twse.com.tw/rwd/zh/fund/T86?date=20260814&selectType=ALL&response=json',
    });
    expect(TWSE_INSTITUTIONAL_BY_STOCK.url).toContain(DATE_PLACEHOLDER);
  });

  it('日期提供者本次失敗時，寧可不抓也不猜日期', () => {
    // 用今天的日期去猜會在週末、國定假日、颱風假抓到空資料
    const result = resolveSourceUrl(TWSE_INSTITUTIONAL_BY_STOCK, new Map());
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('twse_stock_day_all');
      expect(result.error).toContain('未成功取得日期');
    }
  });

  it('註冊表漏填 dateFrom 時明確報錯，不靜默通過', () => {
    const broken = { ...TWSE_INSTITUTIONAL_BY_STOCK, dateFrom: null };
    const result = resolveSourceUrl(broken, new Map());
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('未指定 dateFrom');
    }
  });

  it('提供者的日期無法轉格式時報錯而非產生壞網址', () => {
    const dates = new Map<SourceId, string>([['twse_stock_day_all', '2026-02-30']]);
    const result = resolveSourceUrl(TWSE_INSTITUTIONAL_BY_STOCK, dates);
    expect('error' in result).toBe(true);
  });
});
