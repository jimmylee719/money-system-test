import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileSnapshotStore } from '../file-store';
import { ingestAll, ingestSource } from '../ingest';
import { TPEX_MAINBOARD_PERATIO_ANALYSIS, TWSE_BWIBBU_ALL, TWSE_STOCK_DAY_ALL } from '../sources';
import type { L0Deps, SourceDescriptor } from '../types';

const BODY_A = JSON.stringify([{ Date: '1150814', Code: '1101' }]);
const BODY_B = JSON.stringify([{ Date: '1150814', Code: '2330' }]);

function makeDeps(handler: (url: string) => Response): { deps: L0Deps; sleepCalls: number[] } {
  let tick = 0;
  const sleepCalls: number[] = [];
  return {
    sleepCalls,
    deps: {
      fetchImpl: (async (input: string | URL | Request) =>
        handler(String(input))) as unknown as L0Deps['fetchImpl'],
      now: () => {
        const d = new Date(Date.UTC(2026, 7, 16, 0, 0, 0, 0) + tick * 1000);
        tick += 1;
        return d;
      },
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    },
  };
}

let store: FileSnapshotStore;

beforeEach(async () => {
  store = new FileSnapshotStore(await mkdtemp(path.join(tmpdir(), 'l0-ingest-')));
});

describe('ingestSource', () => {
  it('stores on first run and reports duplicate on the second identical run', async () => {
    const { deps } = makeDeps(() => new Response(BODY_A, { status: 200 }));

    const first = await ingestSource(TWSE_STOCK_DAY_ALL, deps, store);
    const second = await ingestSource(TWSE_STOCK_DAY_ALL, deps, store);

    expect(first.status).toBe('stored');
    expect(second.status).toBe('duplicate');
    expect(first.bodyPath).toBe(second.bodyPath);

    const manifest = await store.readManifest();
    expect(manifest).toHaveLength(2);
    expect(manifest.map((m) => m.status)).toEqual(['stored', 'duplicate']);
  });

  it('records schema drift against the registry baseline', async () => {
    // payload 只有 Date/Code 兩欄，且多出一個註冊表沒有的 SurpriseColumn
    const drifted = JSON.stringify([{ Date: '1150814', Code: '1101', SurpriseColumn: 'x' }]);
    const { deps } = makeDeps(() => new Response(drifted, { status: 200 }));

    await ingestSource(TWSE_STOCK_DAY_ALL, deps, store);

    const entry = (await store.readManifest())[0];
    expect(entry?.fieldsAdded).toEqual(['SurpriseColumn']);
    expect(entry?.fieldsRemoved).toContain('ClosingPrice');
    expect(entry?.fieldsRemoved).toContain('TradeVolume');
    expect(entry?.fieldsRemoved).not.toContain('Date');
  });

  it('records no drift when the payload matches the baseline exactly', async () => {
    const exact = JSON.stringify([
      Object.fromEntries(TWSE_STOCK_DAY_ALL.baselineFields.map((f) => [f, f === 'Date' ? '1150814' : ''])),
    ]);
    const { deps } = makeDeps(() => new Response(exact, { status: 200 }));

    await ingestSource(TWSE_STOCK_DAY_ALL, deps, store);

    const entry = (await store.readManifest())[0];
    expect(entry?.fieldsAdded).toEqual([]);
    expect(entry?.fieldsRemoved).toEqual([]);
  });

  it('records a failure in the manifest instead of silently skipping', async () => {
    const { deps } = makeDeps(() => new Response('down', { status: 500 }));

    const result = await ingestSource(TWSE_STOCK_DAY_ALL, deps, store, {
      fetch: { timeoutMs: 1000, maxAttempts: 2, retryBaseDelayMs: 1 },
      politenessDelayMs: 0,
    });

    expect(result.status).toBe('failed');
    expect(result.snapshot).toBe(null);
    expect(result.error).toContain('HTTP 500');

    const manifest = await store.readManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0]?.status).toBe('failed');
    expect(manifest[0]?.contentHash).toBe(null);
    expect(manifest[0]?.snapshot).toBe(null);
    expect(manifest[0]?.error).toContain('HTTP 500');
  });
});

describe('ingestAll', () => {
  const SOURCES: readonly SourceDescriptor[] = [
    TWSE_STOCK_DAY_ALL,
    TWSE_BWIBBU_ALL,
    TPEX_MAINBOARD_PERATIO_ANALYSIS,
  ];

  it('continues past a failing source and records every outcome', async () => {
    const { deps } = makeDeps((url) => {
      if (url === TWSE_BWIBBU_ALL.url) {
        return new Response('nope', { status: 404 });
      }
      return new Response(url === TWSE_STOCK_DAY_ALL.url ? BODY_A : BODY_B, { status: 200 });
    });

    const results = await ingestAll(deps, store, SOURCES, {
      fetch: { timeoutMs: 1000, maxAttempts: 1, retryBaseDelayMs: 1 },
      politenessDelayMs: 0,
    });

    expect(results.map((r) => r.status)).toEqual(['stored', 'failed', 'stored']);
    expect(await store.readManifest()).toHaveLength(3);
  });

  it('waits between sources but not before the first', async () => {
    const { deps, sleepCalls } = makeDeps(() => new Response(BODY_A, { status: 200 }));

    await ingestAll(deps, store, SOURCES, {
      fetch: { timeoutMs: 1000, maxAttempts: 1, retryBaseDelayMs: 1 },
      politenessDelayMs: 250,
    });

    expect(sleepCalls).toEqual([250, 250]);
  });

  it('fetches sources sequentially, never in parallel', async () => {
    const order: string[] = [];
    const handler = vi.fn((url: string) => {
      order.push(url);
      return new Response(BODY_A, { status: 200 });
    });
    const { deps } = makeDeps(handler);

    await ingestAll(deps, store, SOURCES, {
      fetch: { timeoutMs: 1000, maxAttempts: 1, retryBaseDelayMs: 1 },
      politenessDelayMs: 0,
    });

    expect(order).toEqual(SOURCES.map((s) => s.url));
  });

  it('separates data_as_of from fetched_at in every stored manifest entry', async () => {
    const { deps } = makeDeps(() => new Response(BODY_A, { status: 200 }));

    await ingestAll(deps, store, SOURCES, {
      fetch: { timeoutMs: 1000, maxAttempts: 1, retryBaseDelayMs: 1 },
      politenessDelayMs: 0,
    });

    const manifest = await store.readManifest();
    for (const entry of manifest) {
      expect(entry.dataAsOf).toBe('2026-08-14');
      expect(entry.fetchedAt.startsWith('2026-08-16')).toBe(true);
      expect(entry.snapshot?.dataAsOfReason).toBe('single_date_in_payload');
    }
  });
});
