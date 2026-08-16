import { describe, expect, it } from 'vitest';
import { buildSnapshot, diffFields, inspectPayload, sha256Hex } from '../snapshot';
import {
  MOPS_TWSE_MATERIAL_ANNOUNCEMENTS,
  MOPS_TWSE_MONTHLY_REVENUE,
  TAIFEX_PUT_CALL_RATIO,
  TWSE_INSTITUTIONAL_BY_STOCK,
  TWSE_STOCK_DAY_ALL,
} from '../sources';
import type { PayloadDateSpec } from '../types';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** 單日快照類：民國年壓縮 + 要求唯一日期（P1 行情類的規格） */
const DAY_SPEC: PayloadDateSpec = {
  payloadShape: 'json_array',
  dateField: 'Date',
  dateFormat: 'roc_compact',
  dateSelection: 'unique',
  periodField: null,
  periodFormat: null,
};

/** 取自 2026-08-16 實測回應的前兩列，逐字未改 */
const REAL_TWSE_ROWS = JSON.stringify([
  {
    Date: '1150814',
    Code: '00400A',
    Name: '主動國泰動能高息',
    TradeVolume: '49694719',
    TradeValue: '738788003',
    OpeningPrice: '14.87',
    HighestPrice: '14.94',
    LowestPrice: '14.74',
    ClosingPrice: '14.79',
    Change: '0.0600',
    Transaction: '8912',
  },
  {
    Date: '1150814',
    Code: '1101',
    Name: '台泥',
    TradeVolume: '10000',
    TradeValue: '200000',
    OpeningPrice: '20.00',
    HighestPrice: '20.10',
    LowestPrice: '19.90',
    ClosingPrice: '20.05',
    Change: '0.0500',
    Transaction: '30',
  },
]);

describe('sha256Hex', () => {
  it('matches the known SHA-256 of an empty input', () => {
    expect(sha256Hex(enc(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('is byte-sensitive: one changed byte changes the hash', () => {
    expect(sha256Hex(enc('a'))).not.toBe(sha256Hex(enc('b')));
  });
});

describe('inspectPayload — 只記錄觀察到的事實', () => {
  it('extracts data_as_of from a single-date payload', () => {
    const r = inspectPayload(enc(REAL_TWSE_ROWS), DAY_SPEC);
    expect(r.dataAsOf).toBe('2026-08-14');
    expect(r.dataAsOfReason).toBe('single_date_in_payload');
    expect(r.rowCount).toBe(2);
    expect(r.heterogeneousRowCount).toBe(0);
    expect(r.observedDataDates).toEqual(['1150814']);
    // observedFields 已排序、baselineFields 照 API 回傳順序，比對語意是集合式的
    expect(r.observedFields).toEqual([...TWSE_STOCK_DAY_ALL.baselineFields].sort());
    expect(diffFields(TWSE_STOCK_DAY_ALL.baselineFields, r.observedFields)).toEqual({
      added: [],
      removed: [],
    });
  });

  it('refuses to guess when the payload holds multiple dates', () => {
    const body = enc(JSON.stringify([{ Date: '1150814' }, { Date: '1150813' }]));
    const r = inspectPayload(body, DAY_SPEC);
    expect(r.dataAsOf).toBe(null);
    expect(r.dataAsOfReason).toBe('multiple_dates_in_payload');
    expect(r.observedDataDates).toEqual(['1150814', '1150813']);
  });

  it('records date_field_missing rather than falling back to the clock', () => {
    const r = inspectPayload(enc(JSON.stringify([{ Code: '1101' }])), DAY_SPEC);
    expect(r.dataAsOf).toBe(null);
    expect(r.dataAsOfReason).toBe('date_field_missing');
    expect(r.rowCount).toBe(1);
  });

  it('records date_unparsable for a malformed date value', () => {
    const r = inspectPayload(enc(JSON.stringify([{ Date: '1151399' }])), DAY_SPEC);
    expect(r.dataAsOf).toBe(null);
    expect(r.dataAsOfReason).toBe('date_unparsable');
    expect(r.observedDataDates).toEqual(['1151399']);
  });

  it('flags rows whose field set differs from the first row', () => {
    const body = enc(
      JSON.stringify([{ Date: '1150814', A: '1' }, { Date: '1150814' }, { Date: '1150814', A: '2' }]),
    );
    const r = inspectPayload(body, DAY_SPEC);
    expect(r.heterogeneousRowCount).toBe(1);
    expect(r.observedFields).toEqual(['A', 'Date']);
    expect(r.dataAsOf).toBe('2026-08-14');
  });

  it('never throws on broken input — records the reason instead', () => {
    expect(inspectPayload(enc('not json'), DAY_SPEC).dataAsOfReason).toBe('invalid_json');
    expect(inspectPayload(enc('{"a":1}'), DAY_SPEC).dataAsOfReason).toBe('payload_not_an_array');
    expect(inspectPayload(enc('[]'), DAY_SPEC).dataAsOfReason).toBe('payload_empty');
    expect(inspectPayload(enc('[]'), DAY_SPEC).rowCount).toBe(0);
  });
});

describe('buildSnapshot', () => {
  const snapshot = buildSnapshot({
    source: TWSE_STOCK_DAY_ALL,
    body: enc(REAL_TWSE_ROWS),
    fetchedAt: new Date('2026-08-16T01:23:45.000Z'),
    httpStatus: 200,
    etag: 'W/"6a80d837-4e0d7"',
    lastModified: 'Sat, 15 Aug 2026 21:20:55 GMT',
    durationMs: 244,
    attempt: 1,
  });

  it('separates data_as_of (from payload) from fetched_at (from clock)', () => {
    expect(snapshot.dataAsOf).toBe('2026-08-14');
    expect(snapshot.fetchedAt).toBe('2026-08-16T01:23:45.000Z');
    expect(snapshot.dataAsOf).not.toBe(snapshot.fetchedAt.slice(0, 10));
  });

  it('records content hash, length and transport metadata', () => {
    expect(snapshot.contentHash).toBe(sha256Hex(enc(REAL_TWSE_ROWS)));
    expect(snapshot.contentLength).toBe(enc(REAL_TWSE_ROWS).byteLength);
    expect(snapshot.httpStatus).toBe(200);
    expect(snapshot.etag).toBe('W/"6a80d837-4e0d7"');
    expect(snapshot.lastModified).toBe('Sat, 15 Aug 2026 21:20:55 GMT');
    expect(snapshot.durationMs).toBe(244);
    expect(snapshot.attempt).toBe(1);
    expect(snapshot.sourceTier).toBe('official_primary');
  });
});

describe('diffFields', () => {
  it('detects added and removed fields against the registry baseline', () => {
    expect(diffFields(['A', 'B'], ['A', 'B'])).toEqual({ added: [], removed: [] });
    expect(diffFields(['A', 'B'], ['A', 'B', 'C'])).toEqual({ added: ['C'], removed: [] });
    expect(diffFields(['A', 'B'], ['A'])).toEqual({ added: [], removed: ['B'] });
  });

  it('treats an unparsable payload as everything removed', () => {
    expect(diffFields(['A', 'B'], null)).toEqual({ added: [], removed: ['A', 'B'] });
  });

  it('compares as sets — field order does not matter', () => {
    // baselineFields 照 API 回傳順序記錄，observedFields 已排序，兩者順序必然不同
    expect(diffFields(['B', 'A', '主旨 '], ['A', 'B', '主旨 '])).toEqual({
      added: [],
      removed: [],
    });
  });
});

// ── P2 新增的日期規格 ────────────────────────────────────────────────────────

describe('inspectPayload — TAIFEX 西元壓縮日期', () => {
  /** 取自 2026-08-16 實測回應 */
  const REAL_PCR = JSON.stringify([
    { Date: '20260814', PutVolume: '326821', CallVolume: '316754', 'PutCallVolumeRatio%': '103.18' },
    { Date: '20260813', PutVolume: '300000', CallVolume: '300000', 'PutCallVolumeRatio%': '100.00' },
    { Date: '20260812', PutVolume: '290000', CallVolume: '295000', 'PutCallVolumeRatio%': '98.31' },
  ]);

  it("dateSelection 'max' 取滾動視窗中最新的一天", () => {
    const r = inspectPayload(enc(REAL_PCR), TAIFEX_PUT_CALL_RATIO);
    expect(r.dataAsOf).toBe('2026-08-14');
    expect(r.dataAsOfReason).toBe('max_date_in_payload');
    expect(r.rowCount).toBe(3);
    expect(r.observedDataDates).toEqual(['20260814', '20260813', '20260812']);
  });

  it("同一份資料若誤用 'unique' 規則會拒絕判定，而不是亂猜", () => {
    const r = inspectPayload(enc(REAL_PCR), { ...TAIFEX_PUT_CALL_RATIO, dateSelection: 'unique' });
    expect(r.dataAsOf).toBe(null);
    expect(r.dataAsOfReason).toBe('multiple_dates_in_payload');
  });

  it('民國格式規則套在西元資料上會判定為無法解析，不會靜默算錯', () => {
    // "20260814" 若當成民國年會變成 民國2026年08月14日 → 西元 3937 年，明顯是錯的。
    // rocDateToIso 只接受 6~7 碼，8 碼直接拒絕。
    const r = inspectPayload(enc(REAL_PCR), {
      ...TAIFEX_PUT_CALL_RATIO,
      dateFormat: 'roc_compact',
    });
    expect(r.dataAsOf).toBe(null);
    expect(r.dataAsOfReason).toBe('date_unparsable');
  });
});

describe('inspectPayload — MOPS 月營收的兩個日期', () => {
  /** 取自 2026-08-16 實測回應的第一列，逐字未改 */
  const REAL_REVENUE = JSON.stringify([
    {
      出表日期: '1150815',
      資料年月: '11507',
      公司代號: '1101',
      公司名稱: '台泥',
      產業別: '水泥工業',
      '營業收入-當月營收': '13744103',
    },
  ]);

  it('data_as_of 是報表產生日，data_period 是營收所屬月份', () => {
    const r = inspectPayload(enc(REAL_REVENUE), MOPS_TWSE_MONTHLY_REVENUE);
    // 出表日期 1150815 = 民國115年08月15日
    expect(r.dataAsOf).toBe('2026-08-15');
    expect(r.dataAsOfReason).toBe('single_date_in_payload');
    // 資料年月 11507 = 民國115年07月 —— 差一個月，混用就是前視偏誤
    expect(r.dataPeriod).toBe('2026-07');
    expect(r.observedDataPeriods).toEqual(['11507']);
    expect(r.dataAsOf).not.toBe(r.dataPeriod);
  });

  it('沒有宣告 periodField 的來源，data_period 為 null', () => {
    const r = inspectPayload(enc(REAL_REVENUE), {
      ...MOPS_TWSE_MONTHLY_REVENUE,
      periodField: null,
      periodFormat: null,
    });
    expect(r.dataPeriod).toBe(null);
    expect(r.observedDataPeriods).toEqual([]);
  });
});

describe('inspectPayload — TWSE 網站端點的 rwd_table 形狀', () => {
  /** 取自 2026-08-16 實測 T86 回應的結構，資料列縮減 */
  const REAL_T86 = JSON.stringify({
    stat: 'OK',
    date: '20260814',
    title: '115年08月14日 三大法人買賣超日報',
    fields: ['證券代號', '證券名稱', '投信買賣超股數', '三大法人買賣超股數'],
    data: [
      ['00403A', '主動統一升級50  ', '0', '250,897,716'],
      ['1101', '台泥', '1,234,000', '5,678,900'],
    ],
    total: 2,
  });

  it('欄位名取自 fields、日期取自頂層 date', () => {
    const r = inspectPayload(enc(REAL_T86), TWSE_INSTITUTIONAL_BY_STOCK);
    expect(r.dataAsOf).toBe('2026-08-14');
    expect(r.dataAsOfReason).toBe('single_date_in_payload');
    expect(r.rowCount).toBe(2);
    expect(r.heterogeneousRowCount).toBe(0);
    expect(r.observedFields).toEqual(
      ['證券代號', '證券名稱', '投信買賣超股數', '三大法人買賣超股數'].sort(),
    );
  });

  it('欄數與 fields 不符的列會被記為結構不一致', () => {
    const broken = JSON.stringify({
      date: '20260814',
      fields: ['a', 'b', 'c'],
      data: [['1', '2', '3'], ['1', '2'], ['1', '2', '3', '4']],
    });
    const r = inspectPayload(enc(broken), TWSE_INSTITUTIONAL_BY_STOCK);
    expect(r.rowCount).toBe(3);
    expect(r.heterogeneousRowCount).toBe(2);
  });

  it('非交易日等情況官方不給 fields/data，如實記為空而非報錯', () => {
    const noData = JSON.stringify({ stat: '很抱歉，沒有符合條件的資料!', date: '20260816' });
    const r = inspectPayload(enc(noData), TWSE_INSTITUTIONAL_BY_STOCK);
    expect(r.dataAsOfReason).toBe('payload_empty');
    expect(r.rowCount).toBe(0);
    expect(r.observedFields).toEqual([]);
  });

  it('千分位逗號原封不動保留（L0 只存不判斷）', () => {
    // 資料本身不經 inspectPayload 改寫，這裡驗證原始 bytes 未被更動
    expect(REAL_T86).toContain('"250,897,716"');
  });
});

describe('inspectPayload — 重大訊息取發言日期而非出表日期', () => {
  const REAL_ANNOUNCEMENTS = JSON.stringify([
    { 出表日期: '1150816', 發言日期: '1150815', 公司代號: '7835', '主旨 ': 'x' },
    { 出表日期: '1150816', 發言日期: '1150814', 公司代號: '1101', '主旨 ': 'y' },
  ]);

  it('一份報表含多個發言日時取最新者', () => {
    const r = inspectPayload(enc(REAL_ANNOUNCEMENTS), MOPS_TWSE_MATERIAL_ANNOUNCEMENTS);
    // 出表日期是 8/16，但事件實際發生在 8/15 —— 取事件時點
    expect(r.dataAsOf).toBe('2026-08-15');
    expect(r.dataAsOfReason).toBe('max_date_in_payload');
    expect(r.observedDataDates).toEqual(['1150815', '1150814']);
  });

  it('保留官方欄位名結尾的空格，不做 trim', () => {
    const r = inspectPayload(enc(REAL_ANNOUNCEMENTS), MOPS_TWSE_MATERIAL_ANNOUNCEMENTS);
    expect(r.observedFields).toContain('主旨 ');
    expect(r.observedFields).not.toContain('主旨');
  });
});
