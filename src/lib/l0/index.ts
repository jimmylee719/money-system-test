/** L0 資料層 public API（P1 行情 + P2 MOPS/TAIFEX） */

export type {
  BodyStore,
  BodyStoreKind,
  DataAsOfReason,
  EndpointStability,
  PayloadShape,
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
  CHIP_SOURCES,
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
  TPEX_INSTITUTIONAL_BY_STOCK,
  TPEX_MAINBOARD_DAILY_CLOSE_QUOTES,
  TPEX_MAINBOARD_PERATIO_ANALYSIS,
  TPEX_MARGIN_BALANCE,
  TWSE_BWIBBU_ALL,
  TWSE_INSTITUTIONAL_BY_STOCK,
  TWSE_MARGIN_BALANCE,
  TWSE_STOCK_DAY_ALL,
} from './sources';

export { ROC_YEAR_OFFSET, isoDateToRoc, rocDateToIso } from './roc-date';

export {
  adCompactToIso,
  isoDateToAdCompact,
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
  PostgrestClient,
  PostgrestOptions,
  RawSnapshotRow,
  SourceHealthRow,
  SourceHealthStatus,
} from './supabase-store';

export {
  DEFAULT_BUCKET,
  StorageError,
  SupabaseStorageBodyStore,
  UNKNOWN_DATE_PREFIX,
  isDuplicateError,
} from './supabase-storage';
export type { SupabaseStorageOptions } from './supabase-storage';

export {
  DATE_PLACEHOLDER,
  DEFAULT_INGEST_OPTIONS,
  createLiveDeps,
  ingestAll,
  ingestSource,
  resolveSourceUrl,
} from './ingest';
export type { IngestOptions } from './ingest';
