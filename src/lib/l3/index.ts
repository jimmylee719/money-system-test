/** P7 — L3 風控層 public API */

export type { RiskConfig } from './config';
export { RISK_CONFIG_V1, validateRiskConfig } from './config';

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
