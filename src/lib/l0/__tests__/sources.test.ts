/** 來源註冊表的一致性檢查（離線，不碰網路） */

import { describe, expect, it } from 'vitest';
import {
  ALL_SOURCES,
  CHIP_SOURCES,
  MOPS_SOURCES,
  QUOTE_SOURCES,
  EXRIGHT_SOURCES,
  SOURCES_BY_ID,
  TAIFEX_SOURCES,
  TRADING_STATUS_SOURCES,
} from '../sources';

describe('來源註冊表', () => {
  it('包含行情 4 + MOPS 6 + TAIFEX 3 + 籌碼 4 + 交易狀態 8 + 除權息 3 個來源', () => {
    expect(QUOTE_SOURCES).toHaveLength(4);
    expect(MOPS_SOURCES).toHaveLength(6);
    expect(TAIFEX_SOURCES).toHaveLength(3);
    expect(CHIP_SOURCES).toHaveLength(4);
    expect(TRADING_STATUS_SOURCES).toHaveLength(8);
    expect(EXRIGHT_SOURCES).toHaveLength(3);
    expect(ALL_SOURCES).toHaveLength(28);
  });

  it('需要日期參數的來源，其日期提供者必須排在它前面', () => {
    const order = new Map(ALL_SOURCES.map((s, i) => [s.id, i]));
    for (const source of ALL_SOURCES) {
      if (source.dateFrom === null) {
        continue;
      }
      const self = order.get(source.id) ?? -1;
      const provider = order.get(source.dateFrom) ?? -1;
      expect(provider, `${source.dateFrom} 必須在註冊表中存在`).toBeGreaterThanOrEqual(0);
      expect(provider, `${source.dateFrom} 必須排在 ${source.id} 之前`).toBeLessThan(self);
    }
  });

  it('網址含日期佔位符者必須指定 dateFrom，反之亦然', () => {
    for (const source of ALL_SOURCES) {
      expect(
        source.url.includes('{date_ad_compact}'),
        `${source.id}: 佔位符與 dateFrom 必須成對`,
      ).toBe(source.dateFrom !== null);
    }
  });

  it('未列於 OpenAPI 目錄的端點必須明確標記，不可混充', () => {
    const internal = ALL_SOURCES.filter((s) => s.endpointStability === 'website_internal');
    // 目前僅有 TWSE 個股三大法人（OpenAPI 目錄查無替代品）
    expect(internal.map((s) => s.id)).toEqual(['twse_institutional_by_stock']);
  });

  it('id 與 url 皆不重複', () => {
    expect(new Set(ALL_SOURCES.map((s) => s.id)).size).toBe(ALL_SOURCES.length);
    expect(new Set(ALL_SOURCES.map((s) => s.url)).size).toBe(ALL_SOURCES.length);
  });

  it('SOURCES_BY_ID 與 ALL_SOURCES 完全對應', () => {
    expect(Object.keys(SOURCES_BY_ID).sort()).toEqual(ALL_SOURCES.map((s) => s.id).sort());
    for (const source of ALL_SOURCES) {
      expect(SOURCES_BY_ID[source.id]).toBe(source);
    }
  });

  it('全部走 HTTPS 且限於官方網域', () => {
    const allowedHosts = [
      'openapi.twse.com.tw',
      'www.tpex.org.tw',
      'openapi.taifex.com.tw',
      'www.twse.com.tw', // 僅供 OpenAPI 目錄查無替代品的端點使用，見下一項
    ];
    for (const source of ALL_SOURCES) {
      const url = new URL(source.url.replace('{date_ad_compact}', '20260814'));
      expect(url.protocol, source.id).toBe('https:');
      expect(allowedHosts, source.id).toContain(url.hostname);
    }
  });

  it('www.twse.com.tw（非 OpenAPI 目錄）只准標記為 website_internal 的來源使用', () => {
    for (const source of ALL_SOURCES) {
      const host = new URL(source.url.replace('{date_ad_compact}', '20260814')).hostname;
      if (host === 'www.twse.com.tw') {
        expect(source.endpointStability, source.id).toBe('website_internal');
      } else {
        expect(source.endpointStability, source.id).toBe('documented_openapi');
      }
    }
  });

  it('全部標記為官方一手來源（CLAUDE.md：唯一可作訊號依據）', () => {
    for (const source of ALL_SOURCES) {
      expect(source.sourceTier).toBe('official_primary');
    }
  });

  it('每個來源都宣告了日期格式與選取規則', () => {
    for (const source of ALL_SOURCES) {
      expect(['roc_compact', 'ad_compact']).toContain(source.dateFormat);
      expect(['unique', 'max']).toContain(source.dateSelection);
      expect(['json_array', 'twse_rwd_table']).toContain(source.payloadShape);
    }
  });

  it('dateField 必須真的存在於基準欄位（twse_rwd_table 的日期在頂層，除外）', () => {
    for (const source of ALL_SOURCES) {
      if (source.dateField === '') {
        // 空字串＝此 payload 確實沒有日期欄位（如 twse_margin_balance），非漏填
        continue;
      }
      if (source.payloadShape === 'twse_rwd_table') {
        // 這種形狀的日期在 payload 頂層，不在欄位清單裡
        continue;
      }
      expect(source.baselineFields, source.id).toContain(source.dateField);
    }
  });

  it('沒有日期欄位的來源僅限已知的例外', () => {
    // 這三個的 payload 實測確實沒有日期欄位，不是漏填。
    // 名單寫死是為了讓「又多一個沒日期的來源」必須經過人看過，不會靜默混進來。
    const noDate = ALL_SOURCES.filter((s) => s.dateField === '').map((s) => s.id);
    expect(noDate).toEqual(['twse_margin_balance', 'twse_suspended', 'twse_altered_trading']);
  });

  it('periodField 與 periodFormat 必須成對出現，且欄位存在於基準欄位', () => {
    for (const source of ALL_SOURCES) {
      expect(source.periodField === null).toBe(source.periodFormat === null);
      if (source.periodField !== null) {
        expect(source.baselineFields).toContain(source.periodField);
      }
    }
  });

  it('基準欄位不重複且非空', () => {
    for (const source of ALL_SOURCES) {
      expect(source.baselineFields.length).toBeGreaterThan(0);
      expect(new Set(source.baselineFields).size).toBe(source.baselineFields.length);
    }
  });

  it('每個來源都註明了實測驗證日與後續用途', () => {
    for (const source of ALL_SOURCES) {
      expect(source.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(source.usedBy.length).toBeGreaterThan(0);
    }
  });

  it('保留官方欄位怪癖，未被「順手修正」', () => {
    const tpexQuotes = SOURCES_BY_ID.tpex_mainboard_daily_close_quotes;
    expect(tpexQuotes.baselineFields).toContain('LatesAskPrice'); // 少一個 t
    expect(tpexQuotes.baselineFields).not.toContain('LatestAskPrice');

    const twseAnn = SOURCES_BY_ID.mops_twse_material_announcements;
    expect(twseAnn.baselineFields).toContain('主旨 '); // 結尾帶空格
    expect(twseAnn.baselineFields).not.toContain('主旨');

    const tpexAnn = SOURCES_BY_ID.mops_tpex_material_announcements;
    expect(tpexAnn.baselineFields).toContain('主旨'); // 櫃買沒有空格
    expect(tpexAnn.baselineFields).not.toContain('主旨 ');

    const tpexProfile = SOURCES_BY_ID.mops_tpex_company_profile;
    expect(tpexProfile.baselineFields).toContain('UnifiedBusinessNo.'); // 結尾帶點
    expect(tpexProfile.baselineFields).toContain('Paidin.Capital.NTDollars');

    const tpexCmode = SOURCES_BY_ID.tpex_altered_trading;
    expect(tpexCmode.baselineFields).toContain(' FinancialAnnouncements'); // 開頭帶空格
    expect(tpexCmode.baselineFields).not.toContain('FinancialAnnouncements');

    // 上櫃暫停交易的欄位名中英夾雜，中文欄位照抄
    const tpexSuspended = SOURCES_BY_ID.tpex_suspended;
    expect(tpexSuspended.baselineFields).toContain('暫停交易');
    expect(tpexSuspended.baselineFields).toContain('恢復交易');

    // 上市除權息預告表：Exdividend 是小寫 d
    const twseEx = SOURCES_BY_ID.twse_exright_forecast;
    expect(twseEx.baselineFields).toContain('Exdividend');
    expect(twseEx.baselineFields).not.toContain('ExDividend');

    // 上櫃除權息預告表：日期欄位是 ExRrightsExDividendDate（Rrights 兩個 r）
    const tpexEx = SOURCES_BY_ID.tpex_exright_forecast;
    expect(tpexEx.dateField).toBe('ExRrightsExDividendDate');
    expect(tpexEx.baselineFields).toContain('ExRrightsExDividendDate');

    // 上櫃除權息計算結果：Diviend / Divdend 兩種不同的拼錯，且兩個都存在
    const tpexDaily = SOURCES_BY_ID.tpex_exright_daily;
    expect(tpexDaily.baselineFields).toContain('ExRightsDiviend');
    expect(tpexDaily.baselineFields).toContain('CashDivdend');
    expect(tpexDaily.baselineFields).toContain('CashDividend');
    expect(tpexDaily.baselineFields).toContain('StockDivdendThousandShares');
  });

  it('除權息預告表一次回傳多個除權息日，必須用 max', () => {
    // 實測：上市 142 列 23 個日期、上櫃 157 列多個日期。
    // 用 unique 會判定為 multiple_dates_in_payload 而永遠取不到 data_as_of。
    expect(SOURCES_BY_ID.twse_exright_forecast.dateSelection).toBe('max');
    expect(SOURCES_BY_ID.tpex_exright_forecast.dateSelection).toBe('max');
    // 計算結果表只有當日，用 unique
    expect(SOURCES_BY_ID.tpex_exright_daily.dateSelection).toBe('unique');
  });

  it('日期格式逐來源宣告，同一交易所也不假設一致', () => {
    // 2026-08-16 實測：同一批上櫃端點，tpex_suspended 用西元（"20260816"），
    // tpex_attention 用民國（"1150814"）。若共用格式會解析錯而不報錯。
    expect(SOURCES_BY_ID.tpex_suspended.dateFormat).toBe('ad_compact');
    expect(SOURCES_BY_ID.tpex_attention.dateFormat).toBe('roc_compact');
    expect(SOURCES_BY_ID.tpex_disposition.dateFormat).toBe('roc_compact');
  });

  it('一次回傳多日公告者用 max，單日快照用 unique', () => {
    // 實測：處置公告一次回傳近期多日（TWSE 8 個日期、TPEx 9 個日期），
    // 用 unique 會判定為 multiple_dates_in_payload 而永遠取不到 data_as_of。
    expect(SOURCES_BY_ID.twse_disposition.dateSelection).toBe('max');
    expect(SOURCES_BY_ID.tpex_disposition.dateSelection).toBe('max');
    expect(SOURCES_BY_ID.twse_attention.dateSelection).toBe('unique');
    expect(SOURCES_BY_ID.tpex_attention.dateSelection).toBe('unique');
  });
});
