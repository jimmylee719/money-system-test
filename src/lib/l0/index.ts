/** L0 資料層 public API（P1 行情 + P2 MOPS/TAIFEX） */

export type {
  DataAsOfReason,
  DateSelection,
  FetchOptions,
  FetchSourceResult,
  IngestResult,
  IngestStatus,
  L0Deps,
  ManifestEntry,
  Market,
  PayloadDateSpec,
  PayloadInspection,
  PutResult,
  RawSnapshot,
  SnapshotStore,
  SourceDateFormat,
  SourceDescriptor,
  SourceId,
  SourcePeriodFormat,
  SourceTier,
} from './types';

export {
  ALL_SOURCES,
  MOPS_SOURCES,
  MOPS_TPEX_COMPANY_PROFILE,
  MOPS_TPEX_MATERIAL_ANNOUNCEMENTS,
  MOPS_TPEX_MONTHLY_REVENUE,
  MOPS_TWSE_COMPANY_PROFILE,
  MOPS_TWSE_MATERIAL_ANNOUNCEMENTS,
  MOPS_TWSE_MONTHLY_REVENUE,
  QUOTE_SOURCES,
  SOURCES_BY_ID,
  TAIFEX_INSTITUTIONAL_FUTURES_OPTIONS,
  TAIFEX_LARGE_TRADERS_FUTURES,
  TAIFEX_PUT_CALL_RATIO,
  TAIFEX_SOURCES,
  TPEX_MAINBOARD_DAILY_CLOSE_QUOTES,
  TPEX_MAINBOARD_PERATIO_ANALYSIS,
  TWSE_BWIBBU_ALL,
  TWSE_STOCK_DAY_ALL,
} from './sources';

export { ROC_YEAR_OFFSET, isoDateToRoc, rocDateToIso } from './roc-date';

export {
  adCompactToIso,
  parseSourceDate,
  parseSourcePeriod,
  rocYearMonthToIsoPeriod,
} from './date-formats';

export { buildSnapshot, diffFields, inspectPayload, sha256Hex } from './snapshot';

export {
  DEFAULT_FETCH_OPTIONS,
  DEFAULT_POLITENESS_DELAY_MS,
  fetchSource,
} from './fetcher';

export { FileSnapshotStore, MANIFEST_FILENAME, UNKNOWN_DATE_DIR } from './file-store';

export {
  Postgrest,
  PostgrestError,
  RAW_SNAPSHOTS_TABLE,
  SOURCE_HEALTH_TABLE,
  SupabaseSnapshotStore,
  deriveHealthStatus,
  toRawSnapshotRow,
  toSourceHealthRow,
} from './supabase-store';
export type {
  BodyStoreKind,
  PostgrestClient,
  PostgrestOptions,
  RawSnapshotRow,
  SourceHealthRow,
  SourceHealthStatus,
} from './supabase-store';

export {
  DEFAULT_INGEST_OPTIONS,
  createLiveDeps,
  ingestAll,
  ingestSource,
} from './ingest';
export type { IngestOptions } from './ingest';
