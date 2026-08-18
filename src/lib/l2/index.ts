/** P6 — L2 否決層 public API */

export type {
  AlteredTradingRow,
  AttentionRow,
  DispositionRow,
  SuspensionRow,
  VetoDecision,
  VetoResult,
  VetoRuleId,
} from './types';

export type { DispositionPeriod, NormalizedStatus } from './normalize';
export {
  normalizeTpexAlteredTrading,
  normalizeTpexAttention,
  normalizeTpexDisposition,
  normalizeTpexSuspension,
  normalizeTwseAlteredTrading,
  normalizeTwseAttention,
  normalizeTwseDisposition,
  normalizeTwseSuspension,
  parseDispositionPeriod,
} from './normalize';

export type { VetoContext, VetoRuleSpec } from './rules';
export {
  RULE_SPECS,
  RULE_SPEC_BY_ID,
  VETO_CHECKS,
  checkAlteredTrading,
  checkAttention,
  checkDisposition,
  checkSuspended,
} from './rules';

export type { SourceAvailability } from './engine';
export {
  VetoLayerViolationError,
  applyVetoes,
  assertOnlySubtracts,
  missingSources,
} from './engine';

export type { BuildVetoRowsInput, VetoEventRow } from './events';
export { VETO_EVENTS_TABLE, VetoEventWriter, buildVetoRows } from './events';

export type { BuildVetoContextInput } from './context';
export {
  SAME_RUN_TOLERANCE_MS,
  VetoSourceStaleError,
  attentionForSignalDate,
  buildVetoContext,
  fetchGapMs,
  isSameRun,
  staleAttentionCount,
} from './context';
