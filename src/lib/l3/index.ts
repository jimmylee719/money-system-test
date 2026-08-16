/** P7 — L3 風控層 public API */

export type { RiskConfig } from './config';
export { ACTIVE_RISK_CONFIG, RISK_CONFIG_V1, RISK_CONFIG_V2, validateRiskConfig } from './config';

export type { DailyVolatility } from './volatility';
export { estimateDailyVolatility, ewmStd, logReturns } from './volatility';

export type { BarrierInput, TripleBarrier } from './barriers';
export { BarrierError, computeBarriers } from './barriers';

export type { SizedPosition, SizingInput, SizingRejectReason, SizingResult } from './sizing';
export { sizePosition } from './sizing';

export type {
  ApprovedSignal,
  RiskContext,
  RiskRejectReason,
  RiskRejection,
  RiskResult,
} from './engine';
export { RiskLayerViolationError, applyRiskLimits, assertOnlySubtracts } from './engine';
