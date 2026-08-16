/**
 * P11 — 讀取 `config/llm.json`。
 *
 * 【設定放檔案而不是環境變數，是刻意的】（CLAUDE.md：Provider 抽象層走設定檔）
 * 環境變數改了不會留痕跡；這個檔案進版控，換模型必然出現在 git diff 裡。
 * 對一個「禁止熱抽換」的系統來說，看得見比方便重要。
 *
 * 檔案裡沒有、也不需要任何金鑰——本機 runtime 不需要金鑰。
 */

import { readFileSync } from 'node:fs';

import { PARAMS_HASH, PROMPT_HASH, PROMPT_VERSION, INFERENCE_PARAMS } from './prompt';
import type { LlmProviderKind, ModelSpec } from './types';
import { assertLocalEndpoint } from './types';

export const LLM_CONFIG_PATH = 'config/llm.json';

export interface LlmConfig {
  /** 整層 LLM 否決的總開關 */
  readonly enabled: boolean;
  /** 參加評測的挑戰者 */
  readonly challenger: ModelSpec;
}

const PROVIDERS: readonly LlmProviderKind[] = ['ollama', 'lmstudio', 'openai_compatible'];

export function parseLlmConfig(raw: unknown): LlmConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError(`${LLM_CONFIG_PATH} 不是物件`);
  }
  const obj = raw as Record<string, unknown>;
  const challenger = obj['challenger'];
  if (typeof challenger !== 'object' || challenger === null) {
    throw new TypeError(`${LLM_CONFIG_PATH} 缺少 challenger`);
  }
  const c = challenger as Record<string, unknown>;
  const modelKey = typeof c['modelKey'] === 'string' ? c['modelKey'].trim() : '';
  const provider = c['provider'];
  const endpoint = typeof c['endpoint'] === 'string' ? c['endpoint'].trim() : '';

  if (modelKey === '') {
    throw new TypeError(`${LLM_CONFIG_PATH}: challenger.modelKey 不可留白`);
  }
  if (typeof provider !== 'string' || !PROVIDERS.includes(provider as LlmProviderKind)) {
    throw new TypeError(
      `${LLM_CONFIG_PATH}: challenger.provider 必須是 ${PROVIDERS.join(' / ')} 之一`,
    );
  }
  // 讀設定的當下就擋，不等到要送請求才擋
  assertLocalEndpoint(endpoint);

  return {
    enabled: obj['enabled'] === true,
    challenger: {
      modelKey,
      provider: provider as LlmProviderKind,
      endpoint,
      role: 'challenger',
      promptVersion: PROMPT_VERSION,
      promptHash: PROMPT_HASH,
      paramsHash: PARAMS_HASH,
      params: INFERENCE_PARAMS,
    },
  };
}

export function loadLlmConfig(path = LLM_CONFIG_PATH): LlmConfig {
  return parseLlmConfig(JSON.parse(readFileSync(path, 'utf8')));
}
