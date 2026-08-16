import { describe, expect, it } from 'vitest';
import { buildSnapshot, diffFields, inspectPayload, sha256Hex } from '../snapshot';
import { TWSE_STOCK_DAY_ALL } from '../sources';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

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
    const r = inspectPayload(enc(REAL_TWSE_ROWS), 'Date');
    expect(r.dataAsOf).toBe('2026-08-14');
    expect(r.dataAsOfReason).toBe('single_date_in_payload');
    expect(r.rowCount).toBe(2);
    expect(r.heterogeneousRowCount).toBe(0);
    expect(r.observedDataDates).toEqual(['1150814']);
    expect(r.observedFields).toEqual([...TWSE_STOCK_DAY_ALL.baselineFields]);
  });

  it('refuses to guess when the payload holds multiple dates', () => {
    const body = enc(JSON.stringify([{ Date: '1150814' }, { Date: '1150813' }]));
    const r = inspectPayload(body, 'Date');
    expect(r.dataAsOf).toBe(null);
    expect(r.dataAsOfReason).toBe('multiple_dates_in_payload');
    expect(r.observedDataDates).toEqual(['1150814', '1150813']);
  });

  it('records date_field_missing rather than falling back to the clock', () => {
    const r = inspectPayload(enc(JSON.stringify([{ Code: '1101' }])), 'Date');
    expect(r.dataAsOf).toBe(null);
    expect(r.dataAsOfReason).toBe('date_field_missing');
    expect(r.rowCount).toBe(1);
  });

  it('records date_unparsable for a malformed date value', () => {
    const r = inspectPayload(enc(JSON.stringify([{ Date: '1151399' }])), 'Date');
    expect(r.dataAsOf).toBe(null);
    expect(r.dataAsOfReason).toBe('date_unparsable');
    expect(r.observedDataDates).toEqual(['1151399']);
  });

  it('flags rows whose field set differs from the first row', () => {
    const body = enc(
      JSON.stringify([{ Date: '1150814', A: '1' }, { Date: '1150814' }, { Date: '1150814', A: '2' }]),
    );
    const r = inspectPayload(body, 'Date');
    expect(r.heterogeneousRowCount).toBe(1);
    expect(r.observedFields).toEqual(['A', 'Date']);
    expect(r.dataAsOf).toBe('2026-08-14');
  });

  it('never throws on broken input — records the reason instead', () => {
    expect(inspectPayload(enc('not json'), 'Date').dataAsOfReason).toBe('invalid_json');
    expect(inspectPayload(enc('{"a":1}'), 'Date').dataAsOfReason).toBe('payload_not_an_array');
    expect(inspectPayload(enc('[]'), 'Date').dataAsOfReason).toBe('payload_empty');
    expect(inspectPayload(enc('[]'), 'Date').rowCount).toBe(0);
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
});
