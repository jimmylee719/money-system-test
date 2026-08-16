/** P4 — 因子預先登記 public API */

export type {
  FactorDefinition,
  FactorRegistrationInput,
  FactorStatus,
  FactorTestResultInput,
  FactorTrialSummary,
  HypothesisDirection,
  RegisteredFactor,
  TestMethod,
  Universe,
  ValidationIssue,
} from './types';
export { FactorValidationError } from './types';

export { canonicalJson, hashDefinition } from './definition-hash';

export {
  FACTOR_KEY_RE,
  MIN_RATIONALE_LENGTH,
  MIN_SAMPLE_SIZE,
  MIN_T_THRESHOLD,
  computePassed,
  validateRegistration,
  validateTestResult,
} from './validation';

export {
  FACTOR_REGISTRY_TABLE,
  FACTOR_STATUS_EVENTS_TABLE,
  FACTOR_TEST_RESULTS_TABLE,
  FACTOR_TRIAL_SUMMARY_VIEW,
  FactorRegistry,
} from './registry';
export type { FactorRegistryReader } from './registry';
