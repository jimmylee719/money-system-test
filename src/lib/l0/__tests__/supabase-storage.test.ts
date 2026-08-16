import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../snapshot';
import { StorageError, SupabaseStorageBodyStore, isDuplicateError } from '../supabase-storage';
import type { RawSnapshot } from '../types';

const BODY = Buffer.from(
  JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ Date: '1150814', Code: String(i) }))),
  'utf8',
);

function snapshotFor(dataAsOf: string | null): RawSnapshot {
  return {
    sourceId: 'twse_stock_day_all',
    dataAsOf,
    contentHash: sha256Hex(BODY),
  } as unknown as RawSnapshot;
}

function makeStore(fetchImpl: unknown): SupabaseStorageBodyStore {
  return new SupabaseStorageBodyStore({
    url: 'https://example.supabase.co/',
    apiKey: 'KEY',
    fetchImpl: fetchImpl as typeof fetch,
  });
}

describe('objectPathFor', () => {
  it('內容定址：路徑含原始 bytes 的 SHA-256', () => {
    const store = makeStore(vi.fn());
    const snapshot = snapshotFor('2026-08-14');
    expect(store.objectPathFor(snapshot)).toBe(
      `twse_stock_day_all/2026-08-14/${snapshot.contentHash}.json.gz`,
    );
  });

  it('日期無法判定時歸入 unknown-date，不亂猜', () => {
    const store = makeStore(vi.fn());
    expect(store.objectPathFor(snapshotFor(null))).toContain('/unknown-date/');
  });
});

describe('put', () => {
  it('上傳的是 gzip 壓縮後的內容，解壓後與原始逐位元組相同', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const store = makeStore(fetchImpl);

    const result = await store.put(snapshotFor('2026-08-14'), BODY);

    expect(result.written).toBe(true);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const uploaded = init.body as Uint8Array;
    // 真的有壓縮
    expect(uploaded.byteLength).toBeLessThan(BODY.length);
    // 解壓後完全一致——壓縮不得損毀資料
    expect(Buffer.from(gunzipSync(Buffer.from(uploaded))).equals(BODY)).toBe(true);
    expect(sha256Hex(gunzipSync(Buffer.from(uploaded)))).toBe(sha256Hex(BODY));
  });

  it('不帶 x-upsert —— 絕不覆蓋既有物件', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await makeStore(fetchImpl).put(snapshotFor('2026-08-14'), BODY);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://example.supabase.co/storage/v1/object/l0-raw/twse_stock_day_all/2026-08-14/${sha256Hex(BODY)}.json.gz`,
    );
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('x-upsert');
    expect(headers['Authorization']).toBe('Bearer KEY');
    expect(headers['Content-Type']).toBe('application/gzip');
  });

  it('物件已存在視為「同內容重複抓取」而非錯誤（append-only 語意）', async () => {
    // ⚠️ 這是 2026-08-16 從 Supabase 實際收到的回應，逐字未改：
    //    HTTP 是 400，409 只出現在 body 的 statusCode 欄位。
    //    先前依「HTTP 409」判斷的版本在實測時直接崩潰，每日重跑都會壞。
    const realResponse =
      '{"statusCode":"409","error":"Duplicate","message":"The resource already exists","code":"KeyAlreadyExists"}';
    const fetchImpl = vi.fn(async () => new Response(realResponse, { status: 400 }));

    const result = await makeStore(fetchImpl).put(snapshotFor('2026-08-14'), BODY);
    expect(result.written).toBe(false);
    expect(result.bodyPath).toContain('.json.gz');
  });

  it('若日後改回真正的 HTTP 409 也仍然認得', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"Duplicate"}', { status: 409 }));
    const result = await makeStore(fetchImpl).put(snapshotFor('2026-08-14'), BODY);
    expect(result.written).toBe(false);
  });

  it('其他錯誤一律拋出，不吞掉', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"Bucket not found"}', { status: 404 }));
    await expect(makeStore(fetchImpl).put(snapshotFor('2026-08-14'), BODY)).rejects.toThrow(
      StorageError,
    );
    await expect(makeStore(fetchImpl).put(snapshotFor('2026-08-14'), BODY)).rejects.toThrow(
      'Bucket not found',
    );
  });
});

describe('get / verify', () => {
  it('下載後解壓，回傳原始 bytes', async () => {
    const { gzipSync } = await import('node:zlib');
    const compressed = gzipSync(BODY, { level: 9 });
    const fetchImpl = vi.fn(async () => new Response(compressed, { status: 200 }));

    const got = await makeStore(fetchImpl).get('a/b/c.json.gz');
    expect(Buffer.from(got).equals(BODY)).toBe(true);
  });

  it('verify 比對解壓後的雜湊，內容被動過即回 false', async () => {
    const { gzipSync } = await import('node:zlib');
    const tampered = Buffer.concat([BODY, Buffer.from('X')]);
    const fetchImpl = vi.fn(async () => new Response(gzipSync(tampered), { status: 200 }));

    const store = makeStore(fetchImpl);
    expect(await store.verify('a/b/c.json.gz', sha256Hex(BODY))).toBe(false);
    expect(await store.verify('a/b/c.json.gz', sha256Hex(tampered))).toBe(true);
  });
});

describe('size —— 容量統計備援（帳本尚無 body_bytes 時使用）', () => {
  it('取中繼資料而非下載內容，才不會吃 egress 額度', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"size":11358}', { status: 200 }));
    const size = await makeStore(fetchImpl).size('a/b/c.json.gz');

    expect(size).toBe(11358);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // 打的是 info 端點，不是下載端點
    expect(url).toBe('https://example.supabase.co/storage/v1/object/info/l0-raw/a/b/c.json.gz');
    expect(init.method).toBe('GET');
  });

  it('物件不存在或回應非預期時回 null，不拋錯中斷稽核', async () => {
    expect(await makeStore(vi.fn(async () => new Response('', { status: 404 }))).size('x')).toBe(
      null,
    );
    expect(
      await makeStore(vi.fn(async () => new Response('not json', { status: 200 }))).size('x'),
    ).toBe(null);
    expect(
      await makeStore(vi.fn(async () => new Response('{"name":"x"}', { status: 200 }))).size('x'),
    ).toBe(null);
  });
});

describe('isDuplicateError', () => {
  it('認得實測到的回應格式', () => {
    expect(
      isDuplicateError(
        '{"statusCode":"409","error":"Duplicate","message":"The resource already exists","code":"KeyAlreadyExists"}',
      ),
    ).toBe(true);
  });

  it('不把其他錯誤誤判為重複', () => {
    expect(isDuplicateError('{"statusCode":"404","error":"Bucket not found"}')).toBe(false);
    expect(isDuplicateError('{"error":"invalid signature"}')).toBe(false);
    expect(isDuplicateError('not json')).toBe(false);
    expect(isDuplicateError('')).toBe(false);
  });
});

describe('kind', () => {
  it('回報 supabase_storage，供帳本寫入 body_store 欄位', () => {
    expect(makeStore(vi.fn()).kind).toBe('supabase_storage');
  });
});
