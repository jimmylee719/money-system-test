/**
 * L0 編排：抓取 → 組快照 → append-only 落地。
 *
 * 依序（非並行）抓取並在來源之間插入禮貌延遲，避免對交易所主機造成壓力。
 * 單一來源失敗不中斷其他來源——失敗本身也是要保存的事實，會寫進 manifest。
 */

import { isoDateToAdCompact } from './date-formats';
import { DEFAULT_FETCH_OPTIONS, DEFAULT_POLITENESS_DELAY_MS, fetchSource } from './fetcher';
import { diffFields } from './snapshot';
import { ALL_SOURCES } from './sources';
import type {
  FetchOptions,
  IngestResult,
  L0Deps,
  SnapshotStore,
  SourceDescriptor,
  SourceId,
} from './types';

/** 網址樣板中的日期佔位符 */
export const DATE_PLACEHOLDER = '{date_ad_compact}';

/**
 * 填入網址中的日期。
 *
 * 日期一律取自 `dateFrom` 指定來源的 data_as_of ——
 * 那是交易所自己宣告的最新交易日，不是我們用系統時鐘推的。
 * 用今天的日期去猜會在週末、國定假日、颱風假抓到空資料。
 */
export function resolveSourceUrl(
  source: SourceDescriptor,
  dataAsOfBySource: ReadonlyMap<SourceId, string>,
): { readonly url: string } | { readonly error: string } {
  if (!source.url.includes(DATE_PLACEHOLDER)) {
    return { url: source.url };
  }
  if (source.dateFrom === null) {
    return { error: `${source.id} 的網址需要日期，但註冊表未指定 dateFrom` };
  }
  const iso = dataAsOfBySource.get(source.dateFrom);
  if (iso === undefined) {
    return {
      error: `${source.id} 需要 ${source.dateFrom} 的 data_as_of 來組網址，但該來源本次未成功取得日期`,
    };
  }
  const compact = isoDateToAdCompact(iso);
  if (compact === null) {
    return { error: `${source.dateFrom} 的 data_as_of「${iso}」無法轉為西元壓縮格式` };
  }
  return { url: source.url.replace(DATE_PLACEHOLDER, compact) };
}

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
  dataAsOfBySource: ReadonlyMap<SourceId, string> = new Map(),
): Promise<IngestResult> {
  const resolved = resolveSourceUrl(source, dataAsOfBySource);
  if ('error' in resolved) {
    // 組不出網址就不抓 —— 不用系統時鐘猜日期。失敗照樣進 manifest。
    await store.appendManifest({
      sourceId: source.id,
      status: 'failed',
      fetchedAt: deps.now().toISOString(),
      dataAsOf: null,
      dataPeriod: null,
      contentHash: null,
      bodyPath: null,
      storedBytes: null,
      error: resolved.error,
      snapshot: null,
      fieldsAdded: [],
      fieldsRemoved: [],
    });
    return {
      sourceId: source.id,
      status: 'failed',
      snapshot: null,
      bodyPath: null,
      error: resolved.error,
    };
  }

  const result = await fetchSource(source, deps, options.fetch, resolved.url);

  if (!result.ok) {
    const entry = {
      sourceId: source.id,
      status: 'failed',
      fetchedAt: deps.now().toISOString(),
      dataAsOf: null,
      dataPeriod: null,
      contentHash: null,
      bodyPath: null,
      storedBytes: null,
      error: result.error,
      snapshot: null,
      // 抓取失敗時無從比對欄位，不假裝「沒有 drift」
      fieldsAdded: [],
      fieldsRemoved: [],
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
  const drift = diffFields(source.baselineFields, result.snapshot.observedFields);

  await store.appendManifest({
    sourceId: source.id,
    status,
    fetchedAt: result.snapshot.fetchedAt,
    dataAsOf: result.snapshot.dataAsOf,
    dataPeriod: result.snapshot.dataPeriod,
    contentHash: result.snapshot.contentHash,
    bodyPath: put.bodyPath,
    storedBytes: put.storedBytes,
    error: null,
    snapshot: result.snapshot,
    fieldsAdded: drift.added,
    fieldsRemoved: drift.removed,
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
  // 已成功取得日期的來源，供需要日期參數的端點組網址
  const dataAsOfBySource = new Map<SourceId, string>();

  for (const [index, source] of sources.entries()) {
    if (index > 0 && options.politenessDelayMs > 0) {
      await deps.sleep(options.politenessDelayMs);
    }
    const result = await ingestSource(source, deps, store, options, dataAsOfBySource);
    if (result.snapshot?.dataAsOf != null) {
      dataAsOfBySource.set(source.id, result.snapshot.dataAsOf);
    }
    results.push(result);
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
