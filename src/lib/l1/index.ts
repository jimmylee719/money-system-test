/** P5 — L1 正規化與標的池 public API */

export type {
  DailyQuote,
  InstitutionalRow,
  L1Market,
  MonthlyRevenueRow,
  Normalized,
  UniverseEntry,
  ValuationRow,
} from './types';

export type { NumericOrNote, ParseStats } from './parse';
export {
  createParseStats,
  mergeParseStats,
  parseInteger,
  parseNumeric,
  parseNumericOrNote,
  parseText,
} from './parse';

export {
  normalizeMonthlyRevenue,
  normalizeTpexCompanyProfile,
  normalizeTpexInstitutional,
  normalizeTpexQuotes,
  normalizeTpexValuation,
  normalizeTwseCompanyProfile,
  normalizeTwseInstitutional,
  normalizeTwseQuotes,
  normalizeTwseValuation,
  rowsFromRwdTable,
} from './normalize';

export type { Universe, UniverseFilterResult, UniverseSummary } from './universe';
export {
  buildUniverse,
  filterToUniverse,
  isInUniverse,
  isTradable,
  mergeUniverses,
  summarizeUniverse,
} from './universe';

export type { LedgerReader, LoadedSnapshot, SnapshotRef } from './loader';
export { SnapshotIntegrityError, SnapshotLoader, SupabaseLedgerReader } from './loader';
