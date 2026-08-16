/** 來源註冊表的一致性檢查（離線，不碰網路） */

import { describe, expect, it } from 'vitest';
import { ALL_SOURCES, MOPS_SOURCES, QUOTE_SOURCES, SOURCES_BY_ID, TAIFEX_SOURCES } from '../sources';

describe('來源註冊表', () => {
  it('包含 P1 的 4 個行情來源與 P2 的 9 個 MOPS/TAIFEX 來源', () => {
    expect(QUOTE_SOURCES).toHaveLength(4);
    expect(MOPS_SOURCES).toHaveLength(6);
    expect(TAIFEX_SOURCES).toHaveLength(3);
    expect(ALL_SOURCES).toHaveLength(13);
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

  it('全部走 HTTPS 且限於三個官方網域', () => {
    const allowedHosts = ['openapi.twse.com.tw', 'www.tpex.org.tw', 'openapi.taifex.com.tw'];
    for (const source of ALL_SOURCES) {
      const url = new URL(source.url);
      expect(url.protocol).toBe('https:');
      expect(allowedHosts).toContain(url.hostname);
    }
  });

  it('全部標記為官方一手來源（CLAUDE.md：唯一可作訊號依據）', () => {
    for (const source of ALL_SOURCES) {
      expect(source.sourceTier).toBe('official_primary');
    }
  });

  it('每個來源都宣告了日期欄位、格式與選取規則', () => {
    for (const source of ALL_SOURCES) {
      expect(source.dateField.length).toBeGreaterThan(0);
      expect(['roc_compact', 'ad_compact']).toContain(source.dateFormat);
      expect(['unique', 'max']).toContain(source.dateSelection);
      // dateField 必須真的在基準欄位裡，否則註冊表自相矛盾
      expect(source.baselineFields).toContain(source.dateField);
    }
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
  });
});
