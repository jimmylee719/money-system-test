/** P11 — 本機 LLM 否決層 public API */

export type {
  Announcement,
  GoldItem,
  LlmProviderKind,
  LlmTask,
  LlmVerdict,
  ModelRole,
  ModelSpec,
  RegisteredModel,
  Verdict,
} from './types';
export { LOCAL_ENDPOINT_PATTERN, NonLocalEndpointError, assertLocalEndpoint } from './types';

export { announcementHash, buildItemKey, parseAnnouncements } from './announce';

export {
  INFERENCE_PARAMS,
  PARAMS_HASH,
  PROMPT_HASH,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  buildUserPrompt,
} from './prompt';

export type { ParsedResponse } from './verdict';
export {
  MIN_QUOTE_CHARS,
  extractJsonObject,
  parseResponse,
  stripWhitespace,
  toVerdict,
  verifyQuote,
} from './verdict';

export type { ChatProvider, CompletionResult } from './provider';
export {
  DEFAULT_TIMEOUT_MS,
  LlmProviderError,
  OpenAiCompatibleProvider,
  StubProvider,
} from './provider';

export type { GoldScore } from './gold';
export {
  MIN_GOLD_SAMPLE,
  baselineScore,
  goldSetHash,
  isDegenerate,
  latestRevisions,
  scoreAgainstGold,
} from './gold';

export type { PromotionDecision, PromotionInput } from './promotion';
export { evaluatePromotion } from './promotion';

export type { LlmVetoInput, LlmVetoOutcome } from './apply';
export { applyLlmVetoes } from './apply';
