import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FileSnapshotStore, UNKNOWN_DATE_DIR } from '../file-store';
import { buildSnapshot } from '../snapshot';
import { TWSE_STOCK_DAY_ALL } from '../sources';
import type { RawSnapshot } from '../types';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function snapshotFor(body: string, fetchedAt: string): RawSnapshot {
  return buildSnapshot({
    source: TWSE_STOCK_DAY_ALL,
    body: enc(body),
    fetchedAt: new Date(fetchedAt),
    httpStatus: 200,
    etag: null,
    lastModified: null,
    durationMs: 10,
    attempt: 1,
  });
}

let root: string;
let store: FileSnapshotStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'l0-store-'));
  store = new FileSnapshotStore(root);
});

describe('FileSnapshotStore — append-only', () => {
  const BODY = JSON.stringify([{ Date: '1150814', Code: '1101' }]);

  it('stores the body under sourceId/dataAsOf/<sha256>.json byte-for-byte', async () => {
    const snapshot = snapshotFor(BODY, '2026-08-16T01:00:00.000Z');
    const put = await store.put(snapshot, enc(BODY));

    expect(put.written).toBe(true);
    expect(put.bodyPath).toBe(
      path.join(root, 'twse_stock_day_all', '2026-08-14', `${snapshot.contentHash}.json`),
    );
    expect(await readFile(put.bodyPath, 'utf8')).toBe(BODY);
  });

  it('does not rewrite when the same content is fetched again', async () => {
    const first = await store.put(snapshotFor(BODY, '2026-08-16T01:00:00.000Z'), enc(BODY));
    const mtimeBefore = (await stat(first.bodyPath)).mtimeMs;

    // 隔天再抓一次，內容完全相同
    const second = await store.put(snapshotFor(BODY, '2026-08-17T01:00:00.000Z'), enc(BODY));

    expect(second.written).toBe(false);
    expect(second.bodyPath).toBe(first.bodyPath);
    expect((await stat(first.bodyPath)).mtimeMs).toBe(mtimeBefore);

    const files = await readdir(path.join(root, 'twse_stock_day_all', '2026-08-14'));
    expect(files).toHaveLength(1);
  });

  it('keeps both versions when content changes — old data is never overwritten', async () => {
    const bodyA = JSON.stringify([{ Date: '1150814', Code: '1101', ClosingPrice: '20.00' }]);
    const bodyB = JSON.stringify([{ Date: '1150814', Code: '1101', ClosingPrice: '20.05' }]);

    const a = await store.put(snapshotFor(bodyA, '2026-08-16T01:00:00.000Z'), enc(bodyA));
    const b = await store.put(snapshotFor(bodyB, '2026-08-16T02:00:00.000Z'), enc(bodyB));

    expect(a.written).toBe(true);
    expect(b.written).toBe(true);
    expect(a.bodyPath).not.toBe(b.bodyPath);

    const files = await readdir(path.join(root, 'twse_stock_day_all', '2026-08-14'));
    expect(files).toHaveLength(2);
    // 舊檔內容原封不動
    expect(await readFile(a.bodyPath, 'utf8')).toBe(bodyA);
  });

  it('files an unparsable payload under unknown-date instead of guessing', async () => {
    const junk = 'not json at all';
    const put = await store.put(snapshotFor(junk, '2026-08-16T01:00:00.000Z'), enc(junk));
    expect(put.bodyPath).toContain(path.join('twse_stock_day_all', UNKNOWN_DATE_DIR));
    expect(await readFile(put.bodyPath, 'utf8')).toBe(junk);
  });

  it('appends one manifest line per fetch, including duplicates', async () => {
    const s1 = snapshotFor(BODY, '2026-08-16T01:00:00.000Z');
    const s2 = snapshotFor(BODY, '2026-08-17T01:00:00.000Z');
    await store.put(s1, enc(BODY));
    await store.appendManifest({
      sourceId: s1.sourceId,
      status: 'stored',
      fetchedAt: s1.fetchedAt,
      dataAsOf: s1.dataAsOf,
      contentHash: s1.contentHash,
      bodyPath: store.bodyPathFor(s1),
      error: null,
      snapshot: s1,
    });
    await store.put(s2, enc(BODY));
    await store.appendManifest({
      sourceId: s2.sourceId,
      status: 'duplicate',
      fetchedAt: s2.fetchedAt,
      dataAsOf: s2.dataAsOf,
      contentHash: s2.contentHash,
      bodyPath: store.bodyPathFor(s2),
      error: null,
      snapshot: s2,
    });

    const manifest = await store.readManifest();
    expect(manifest).toHaveLength(2);
    expect(manifest[0]?.status).toBe('stored');
    expect(manifest[1]?.status).toBe('duplicate');
    // 兩筆 fetched_at 不同，但 content_hash 相同——這正是「同內容重抓」的證據
    expect(manifest[0]?.fetchedAt).not.toBe(manifest[1]?.fetchedAt);
    expect(manifest[0]?.contentHash).toBe(manifest[1]?.contentHash);
  });

  it('returns an empty manifest before anything is written', async () => {
    expect(await store.readManifest()).toEqual([]);
  });

  it('exposes no delete or update method', () => {
    const api = Object.getOwnPropertyNames(FileSnapshotStore.prototype);
    expect(api).not.toContain('delete');
    expect(api).not.toContain('update');
    expect(api).not.toContain('remove');
    expect(api.sort()).toEqual(
      ['appendManifest', 'bodyPathFor', 'constructor', 'manifestPath', 'put', 'readManifest', 'root'].sort(),
    );
  });
});
