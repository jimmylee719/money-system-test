/** P1 — L0 資料層 public API */

export type {
  DataAsOfReason,
  FetchOptions,
  FetchSourceResult,
  IngestResult,
  IngestStatus,
  L0Deps,
  ManifestEntry,
  Market,
  PayloadInspection,
  PutResult,
  RawSnapshot,
  SnapshotStore,
  SourceDescriptor,
  SourceId,
  SourceTier,
} from './types';

export {
  ALL_SOURCES,
  SOURCES_BY_ID,
  TPEX_MAINBOARD_DAILY_CLOSE_QUOTES,
  TPEX_MAINBOARD_PERATIO_ANALYSIS,
  TWSE_BWIBBU_ALL,
  TWSE_STOCK_DAY_ALL,
} from './sources';

export { ROC_YEAR_OFFSET, isoDateToRoc, rocDateToIso } from './roc-date';

export { buildSnapshot, diffFields, inspectPayload, sha256Hex } from './snapshot';

export {
  DEFAULT_FETCH_OPTIONS,
  DEFAULT_POLITENESS_DELAY_MS,
  fetchSource,
} from './fetcher';

export { FileSnapshotStore, MANIFEST_FILENAME, UNKNOWN_DATE_DIR } from './file-store';

export {
  DEFAULT_INGEST_OPTIONS,
  createLiveDeps,
  ingestAll,
  ingestSource,
} from './ingest';
export type { IngestOptions } from './ingest';
