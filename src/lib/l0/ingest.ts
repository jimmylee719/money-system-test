/**
 * L0 編排：抓取 → 組快照 → append-only 落地。
 *
 * 依序（非並行）抓取並在來源之間插入禮貌延遲，避免對交易所主機造成壓力。
 * 單一來源失敗不中斷其他來源——失敗本身也是要保存的事實，會寫進 manifest。
 */

import { DEFAULT_FETCH_OPTIONS, DEFAULT_POLITENESS_DELAY_MS, fetchSource } from './fetcher';
import { ALL_SOURCES } from './sources';
import type {
  FetchOptions,
  IngestResult,
  L0Deps,
  SnapshotStore,
  SourceDescriptor,
} from './types';

export interface IngestOptions {
  readonly fetch: FetchOptions;
  readonly politenessDelayMs: number;
}

export const DEFAULT_INGEST_OPTIONS: IngestOptions = {
  fetch: DEFAULT_FETCH_OPTIONS,
  politenessDelayMs: DEFAULT_POLITENESS_DELAY_MS,
};

export async function ingestSource(
  source: SourceDescriptor,
  deps: L0Deps,
  store: SnapshotStore,
  options: IngestOptions = DEFAULT_INGEST_OPTIONS,
): Promise<IngestResult> {
  const result = await fetchSource(source, deps, options.fetch);

  if (!result.ok) {
    const entry = {
      sourceId: source.id,
      status: 'failed',
      fetchedAt: deps.now().toISOString(),
      dataAsOf: null,
      contentHash: null,
      bodyPath: null,
      error: result.error,
      snapshot: null,
    } as const;
    await store.appendManifest(entry);
    return {
      sourceId: source.id,
      status: 'failed',
      snapshot: null,
      bodyPath: null,
      error: result.error,
    };
  }

  const put = await store.put(result.snapshot, result.body);
  const status = put.written ? 'stored' : 'duplicate';

  await store.appendManifest({
    sourceId: source.id,
    status,
    fetchedAt: result.snapshot.fetchedAt,
    dataAsOf: result.snapshot.dataAsOf,
    contentHash: result.snapshot.contentHash,
    bodyPath: put.bodyPath,
    error: null,
    snapshot: result.snapshot,
  });

  return {
    sourceId: source.id,
    status,
    snapshot: result.snapshot,
    bodyPath: put.bodyPath,
    error: null,
  };
}

export async function ingestAll(
  deps: L0Deps,
  store: SnapshotStore,
  sources: readonly SourceDescriptor[] = ALL_SOURCES,
  options: IngestOptions = DEFAULT_INGEST_OPTIONS,
): Promise<readonly IngestResult[]> {
  const results: IngestResult[] = [];
  for (const [index, source] of sources.entries()) {
    if (index > 0 && options.politenessDelayMs > 0) {
      await deps.sleep(options.politenessDelayMs);
    }
    results.push(await ingestSource(source, deps, store, options));
  }
  return results;
}

/** 正式執行用的相依：真實 fetch、真實時鐘。 */
export function createLiveDeps(): L0Deps {
  return {
    fetchImpl: (input, init) => fetch(input, init),
    now: () => new Date(),
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}
