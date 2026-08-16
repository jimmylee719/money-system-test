/** P5 — L1 正規化與標的池 public API */

export type {
  DailyQuote,
  InstitutionalRow,
  L1Market,
  MarginRow,
  MonthlyRevenueRow,
  Normalized,
  UniverseEntry,
  ValuationRow,
} from './types';

export {
  FOREIGN_NET_BUY_RATIO_V1,
  MARGIN_BALANCE_CHANGE_V1,
  REV_YOY_MOMENTUM_V1,
  SHORT_TERM_REVERSAL_5D_V1,
  TRUST_NET_BUY_RATIO_V1,
  T_THRESHOLD,
  TEST_PERIOD_END,
  TEST_PERIOD_START,
  V1_FACTORS,
} from './factors/definitions';

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
  normalizeTpexMargin,
  normalizeTpexQuotes,
  normalizeTpexValuation,
  normalizeTwseCompanyProfile,
  normalizeTwseInstitutional,
  normalizeTwseMargin,
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
export {
  SnapshotIntegrityError,
  SnapshotLoader,
  SupabaseLedgerReader,
  latestPerDate,
} from './loader';

export {
  midranksAscending,
  quantileType7,
  ranksToScores,
  scoreCrossSection,
  winsorize,
} from './factors/scoring';
export type { ScoredValues } from './factors/scoring';

export type {
  FactorContext,
  FactorScore,
  InactiveFactor,
  RankedStock,
  RankingResult,
} from './factors/engine';
export {
  ENGINE_VERSION,
  FACTOR_IMPLS,
  NEUTRAL_SCORE,
  WATCHLIST_SIZE,
  rankUniverse,
  selectLatestRevenue,
  watchlist,
} from './factors/engine';

export type { BuildContextInput } from './factors/context';
export { DataAsOfMismatchError, alignDataAsOf, buildFactorContext } from './factors/context';

export type { BuildPickRowsInput, DailyPickRow, PickListKind } from './picks';
export { DAILY_PICKS_TABLE, DailyPicksWriter, buildPickRows } from './picks';
