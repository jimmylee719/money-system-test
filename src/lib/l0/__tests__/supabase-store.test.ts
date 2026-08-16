import { describe, expect, it, vi } from 'vitest';
import {
  Postgrest,
  PostgrestError,
  RAW_SNAPSHOTS_TABLE,
  SOURCE_HEALTH_TABLE,
  SupabaseSnapshotStore,
  deriveHealthStatus,
  toRawSnapshotRow,
  toSourceHealthRow,
} from '../supabase-store';
import { buildSnapshot } from '../snapshot';
import { MOPS_TWSE_MONTHLY_REVENUE, TWSE_STOCK_DAY_ALL } from '../sources';
import type { PostgrestClient } from '../supabase-store';
import type { ManifestEntry, PutResult, RawSnapshot, SnapshotStore } from '../types';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const QUOTE_BODY = JSON.stringify([{ Date: '1150814', Code: '1101' }]);
const REVENUE_BODY = JSON.stringify([{ 出表日期: '1150815', 資料年月: '11507', 公司代號: '1101' }]);

function snapshotOf(source: typeof TWSE_STOCK_DAY_ALL, body: string): RawSnapshot {
  return buildSnapshot({
    source,
    body: enc(body),
    fetchedAt: new Date('2026-08-16T00:46:01.000Z'),
    httpStatus: 200,
    etag: 'W/"abc"',
    lastModified: 'Sat, 15 Aug 2026 21:20:55 GMT',
    durationMs: 226,
    attempt: 1,
  });
}

function entryOf(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  const snapshot = snapshotOf(TWSE_STOCK_DAY_ALL, QUOTE_BODY);
  return {
    sourceId: snapshot.sourceId,
    status: 'stored',
    fetchedAt: snapshot.fetchedAt,
    dataAsOf: snapshot.dataAsOf,
    dataPeriod: snapshot.dataPeriod,
    contentHash: snapshot.contentHash,
    bodyPath: '/data/raw/twse_stock_day_all/2026-08-14/abc.json',
    error: null,
    snapshot,
    fieldsAdded: [],
    fieldsRemoved: [],
    ...overrides,
  };
}

describe('toRawSnapshotRow', () => {
  it('maps camelCase snapshot to snake_case columns', () => {
    const snapshot = snapshotOf(TWSE_STOCK_DAY_ALL, QUOTE_BODY);
    const row = toRawSnapshotRow(snapshot, '/tmp/x.json', 'file');

    expect(row.source_id).toBe('twse_stock_day_all');
    expect(row.data_as_of).toBe('2026-08-14');
    expect(row.data_as_of_reason).toBe('single_date_in_payload');
    expect(row.fetched_at).toBe('2026-08-16T00:46:01.000Z');
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.body_store).toBe('file');
    expect(row.body_path).toBe('/tmp/x.json');
    expect(row.http_status).toBe(200);
    expect(row.attempt).toBe(1);
  });

  it('keeps data_period separate from data_as_of', () => {
    const snapshot = snapshotOf(MOPS_TWSE_MONTHLY_REVENUE, REVENUE_BODY);
    const row = toRawSnapshotRow(snapshot, null, 'file');
    // 出表日 2026-08-15 才公布 2026-07 的營收，兩者不可混用
    expect(row.data_as_of).toBe('2026-08-15');
    expect(row.data_period).toBe('2026-07');
    expect(row.observed_data_periods).toEqual(['11507']);
  });

  it('satisfies the SQL check constraints', () => {
    const row = toRawSnapshotRow(snapshotOf(MOPS_TWSE_MONTHLY_REVENUE, REVENUE_BODY), null, 'file');
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/); // raw_snapshots_content_hash_format
    expect(row.data_period).toMatch(/^[0-9]{4}-[0-9]{2}$/); // raw_snapshots_data_period_format
    expect(['file', 'r2']).toContain(row.body_store); // raw_snapshots_body_store_check
  });
});

describe('deriveHealthStatus — 由嚴重到輕微，第一個成立者勝出', () => {
  it('fetch_failed 優先於一切', () => {
    expect(
      deriveHealthStatus(entryOf({ status: 'failed', snapshot: null, error: 'HTTP 500' })),
    ).toBe('fetch_failed');
  });

  it('schema_drift 次之', () => {
    expect(deriveHealthStatus(entryOf({ fieldsAdded: ['NewCol'] }))).toBe('schema_drift');
    expect(deriveHealthStatus(entryOf({ fieldsRemoved: ['Code'] }))).toBe('schema_drift');
  });

  it('列結構不一致再次之', () => {
    const snapshot = { ...snapshotOf(TWSE_STOCK_DAY_ALL, QUOTE_BODY), heterogeneousRowCount: 3 };
    expect(deriveHealthStatus(entryOf({ snapshot }))).toBe('heterogeneous_rows');
  });

  it('日期無法判定再次之', () => {
    const snapshot = { ...snapshotOf(TWSE_STOCK_DAY_ALL, QUOTE_BODY), dataAsOf: null };
    expect(deriveHealthStatus(entryOf({ snapshot }))).toBe('date_unresolved');
  });

  it('一切正常為 ok', () => {
    expect(deriveHealthStatus(entryOf())).toBe('ok');
  });
});

describe('toSourceHealthRow', () => {
  it('records drift fields and the http status', () => {
    const row = toSourceHealthRow(entryOf({ fieldsAdded: ['X'], fieldsRemoved: ['Y'] }));
    expect(row.status).toBe('schema_drift');
    expect(row.fields_added).toEqual(['X']);
    expect(row.fields_removed).toEqual(['Y']);
    expect(row.http_status).toBe(200);
    expect(row.source_id).toBe('twse_stock_day_all');
  });

  it('records failures with a null snapshot', () => {
    const row = toSourceHealthRow(
      entryOf({ status: 'failed', snapshot: null, contentHash: null, error: 'HTTP 503' }),
    );
    expect(row.status).toBe('fetch_failed');
    expect(row.http_status).toBe(null);
    expect(row.content_hash).toBe(null);
    expect(row.error).toBe('HTTP 503');
  });
});

describe('SupabaseSnapshotStore', () => {
  function fakes(): {
    store: SupabaseSnapshotStore;
    inserts: { table: string; rows: readonly unknown[] }[];
    manifest: ManifestEntry[];
    puts: number;
  } {
    const inserts: { table: string; rows: readonly unknown[] }[] = [];
    const manifest: ManifestEntry[] = [];
    const state = { puts: 0 };

    const bodyStore: SnapshotStore = {
      async put(): Promise<PutResult> {
        state.puts += 1;
        return { bodyPath: '/tmp/body.json', written: true };
      },
      async appendManifest(entry) {
        manifest.push(entry);
      },
      async readManifest() {
        return manifest;
      },
    };
    const client: PostgrestClient = {
      async insert(table, rows) {
        inserts.push({ table, rows });
      },
      async count() {
        return 0;
      },
    };
    return {
      store: new SupabaseSnapshotStore(bodyStore, client),
      inserts,
      manifest,
      get puts() {
        return state.puts;
      },
    };
  }

  it('原始 bytes 交給 bodyStore，不寫進資料庫', async () => {
    const f = fakes();
    const result = await f.store.put(snapshotOf(TWSE_STOCK_DAY_ALL, QUOTE_BODY), enc(QUOTE_BODY));
    expect(result.bodyPath).toBe('/tmp/body.json');
    expect(f.puts).toBe(1);
    expect(f.inserts).toHaveLength(0);
  });

  it('成功抓取時同時寫 raw_snapshots 與 source_health，本機 manifest 照留', async () => {
    const f = fakes();
    await f.store.appendManifest(entryOf());

    expect(f.manifest).toHaveLength(1); // 本機備份仍在
    expect(f.inserts.map((i) => i.table)).toEqual([RAW_SNAPSHOTS_TABLE, SOURCE_HEALTH_TABLE]);
    expect(f.inserts[0]?.rows).toHaveLength(1);
    expect(f.inserts[1]?.rows).toHaveLength(1);
  });

  it('抓取失敗時不寫 raw_snapshots，但一定留下 source_health 紀錄', async () => {
    const f = fakes();
    await f.store.appendManifest(
      entryOf({ status: 'failed', snapshot: null, contentHash: null, error: 'HTTP 500' }),
    );

    expect(f.inserts.map((i) => i.table)).toEqual([SOURCE_HEALTH_TABLE]);
    const row = (f.inserts[0]?.rows[0] ?? {}) as { status?: string };
    expect(row.status).toBe('fetch_failed');
  });
});

describe('Postgrest', () => {
  it('POSTs an array with the auth headers and return=minimal', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 201 }));
    const client = new Postgrest({
      url: 'https://example.supabase.co/',
      apiKey: 'KEY',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.insert('raw_snapshots', [{ a: 1 }]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.supabase.co/rest/v1/raw_snapshots'); // 尾端斜線已處理
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['apikey']).toBe('KEY');
    expect(headers['Authorization']).toBe('Bearer KEY');
    expect(headers['Prefer']).toBe('return=minimal');
    expect(init.body).toBe(JSON.stringify([{ a: 1 }]));
  });

  it('skips the request entirely when there are no rows', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 201 }));
    const client = new Postgrest({
      url: 'https://example.supabase.co',
      apiKey: 'KEY',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.insert('raw_snapshots', []);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws PostgrestError carrying the status and server message', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"message":"permission denied"}', { status: 403 }),
    );
    const client = new Postgrest({
      url: 'https://example.supabase.co',
      apiKey: 'KEY',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.insert('raw_snapshots', [{ a: 1 }])).rejects.toThrow(PostgrestError);
    await expect(client.insert('raw_snapshots', [{ a: 1 }])).rejects.toThrow('permission denied');
  });

  it('parses the exact row count out of content-range', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('[]', { status: 200, headers: { 'content-range': '0-0/4217' } }),
    );
    const client = new Postgrest({
      url: 'https://example.supabase.co',
      apiKey: 'KEY',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.count('raw_snapshots')).toBe(4217);
  });
});
