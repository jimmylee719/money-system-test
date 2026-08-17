/**
 * 2026-08-16 事故的回歸測試。
 *
 * 那天 18:57（台北）TWSE 對全部 11 個來源回了 HTTP **200**，內容卻是一頁
 * 「因為安全性考量，您所執行的頁面無法呈現」。抓取層只看狀態碼，照存不誤，
 * 那份 800 bytes 的 HTML 成為 latest 之後，下游整條垮掉。
 *
 * 下面用的就是**當天實際存進資料庫的那份封鎖頁原文**（節錄）。
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_FETCH_OPTIONS, fetchSource } from '../fetcher';
import { UNUSABLE_PAYLOAD_REASONS, isUnusablePayload, looksLikeHtml } from '../snapshot';
import type { L0Deps, SourceDescriptor } from '../types';

/** 2026-08-16 從 Supabase Storage 撈出來的實際內容（節錄） */
const TWSE_BLOCK_PAGE = `<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
</head>
<body>
因為安全性考量，您所執行的頁面無法呈現。<BR>
FOR SECURITY REASONS, THIS PAGE CAN NOT BE ACCESSED.<BR>
<BR>
錯誤代碼：7641438219265657180<BR>
</body>
</html>`;

const SOURCE: SourceDescriptor = {
  id: 'twse_stock_day_all',
  url: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  market: 'TWSE',
  sourceTier: 'official_primary',
  description: '測試用',
  usedBy: '測試',
  verifiedAt: '2026-08-16',
  payloadShape: 'json_array',
  dateFrom: null,
  endpointStability: 'documented_openapi',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  dateSelection: 'max',
  periodField: null,
  periodFormat: null,
  baselineFields: ['Date', 'Code'],
};

function deps(bodyText: string, status = 200): { deps: L0Deps; calls: () => number } {
  let calls = 0;
  let clock = Date.UTC(2026, 7, 16, 10, 57, 13);
  return {
    calls: () => calls,
    deps: {
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(new Response(bodyText, { status }));
      },
      now: () => {
        clock += 1000;
        return new Date(clock);
      },
      sleep: () => Promise.resolve(),
    } as unknown as L0Deps,
  };
}

describe('封鎖頁不得被當成有效快照', () => {
  it('HTTP 200 + HTML 封鎖頁 → 抓取失敗，不回傳快照', async () => {
    const { deps: d } = deps(TWSE_BLOCK_PAGE);
    const result = await fetchSource(SOURCE, d, DEFAULT_FETCH_OPTIONS);
    expect(result.ok).toBe(false);
  });

  it('錯誤訊息要說清楚是 200 但格式不對，並附上對方回了什麼', async () => {
    const { deps: d } = deps(TWSE_BLOCK_PAGE);
    const result = await fetchSource(SOURCE, d, DEFAULT_FETCH_OPTIONS);
    if (result.ok) throw new Error('應該失敗');
    expect(result.error).toContain('HTTP 200');
    expect(result.error).toContain('內容不是登記的格式');
    expect(result.error).toContain('invalid_json');
    // 附上原文片段，看一眼就知道是被擋而不是端點掛掉
    expect(result.error).toContain('安全性考量');
  });

  it('收到 HTML 就不再重試——對被限流的主機重試只會讓封鎖更久', async () => {
    const { deps: d, calls } = deps(TWSE_BLOCK_PAGE);
    await fetchSource(SOURCE, d, DEFAULT_FETCH_OPTIONS);
    expect(calls()).toBe(1);
  });

  it('對照組：非 HTML 的格式錯誤仍然會重試完 maxAttempts', async () => {
    // 合法 JSON 但不是陣列 → payload_not_an_array，不是 HTML，照重試
    const { deps: d, calls } = deps('{"stat":"OK"}');
    const result = await fetchSource(SOURCE, d, DEFAULT_FETCH_OPTIONS);
    expect(result.ok).toBe(false);
    expect(calls()).toBe(DEFAULT_FETCH_OPTIONS.maxAttempts);
  });

  it('對照組：正常的 JSON 陣列照常成功', async () => {
    const { deps: d } = deps(JSON.stringify([{ Date: '1150814', Code: '2330' }]));
    const result = await fetchSource(SOURCE, d, DEFAULT_FETCH_OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.dataAsOf).toBe('2026-08-14');
  });

  it('對照組：空陣列是合法的（當天沒有資料 ≠ 沒拿到資料）', async () => {
    const { deps: d } = deps('[]');
    const result = await fetchSource(SOURCE, d, DEFAULT_FETCH_OPTIONS);
    expect(result.ok).toBe(true);
  });
});

describe('哪些理由算「根本沒拿到資料」', () => {
  it('只有 invalid_json 與 payload_not_an_array 兩種', () => {
    expect([...UNUSABLE_PAYLOAD_REASONS].sort()).toEqual(['invalid_json', 'payload_not_an_array']);
  });

  it('沒有日期的正常來源不算——排掉它們會讓 L2 否決層整個瞎掉', () => {
    // twse_margin_balance / twse_suspended / twse_altered_trading 是 date_field_missing，
    // twse_attention 當日無公告時是 date_unparsable。這些都是正常資料。
    for (const reason of ['date_field_missing', 'date_unparsable', 'payload_empty'] as const) {
      expect(isUnusablePayload(reason)).toBe(false);
    }
    for (const reason of ['invalid_json', 'payload_not_an_array'] as const) {
      expect(isUnusablePayload(reason)).toBe(true);
    }
  });
});

describe('looksLikeHtml', () => {
  it('認得出封鎖頁', () => {
    expect(looksLikeHtml(new TextEncoder().encode(TWSE_BLOCK_PAGE))).toBe(true);
  });

  it('前面有空白換行也認得出來', () => {
    expect(looksLikeHtml(new TextEncoder().encode('\n  <!DOCTYPE html>'))).toBe(true);
  });

  it('JSON 陣列與物件都不是 HTML', () => {
    expect(looksLikeHtml(new TextEncoder().encode('[{"a":1}]'))).toBe(false);
    expect(looksLikeHtml(new TextEncoder().encode('{"stat":"OK"}'))).toBe(false);
  });
});
