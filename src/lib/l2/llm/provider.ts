/**
 * P11 — 模型呼叫抽象層。走 OpenAI 相容的 `/chat/completions`。
 *
 * 【設定檔驅動，不寫死廠商】（CLAUDE.md：Provider 抽象層走設定檔）
 * Ollama 與 LM Studio 都提供 OpenAI 相容端點，因此這裡只需要一種實作，
 * 換 runtime 只是換 `endpoint` 與 `modelKey` 兩個字串。
 *
 * 【不帶任何金鑰，這是刻意的】
 * 本機 runtime 不需要金鑰。這裡也**沒有**讀取金鑰的程式碼，
 * 於是「不小心把請求送到要付費的 API」在結構上就不會成立：
 * 端點被 `assertLocalEndpoint` 限制在 127.0.0.1 / localhost，
 * 就算填了外部網址也會在送出前被擋下。
 * 對應 CLAUDE.md：❌ 不設 ANTHROPIC_API_KEY，本專案零 AI API 支出。
 *
 * ⚠️ **未實測聲明**：本機（2026-08-16）未安裝 Ollama 或 LM Studio，
 *    因此「這段程式能對真實 Ollama 取得回應」尚未經過實測。
 *    已實測的是：端點白名單、請求組裝、逾時、錯誤處理、回應解析（皆以假的 fetch 驗證）。
 *    真實連通性請用 `npm run llm:check` 自行驗證，它只會回報連得上與否，不寫任何資料。
 */

import { INFERENCE_PARAMS } from './prompt';
import type { ModelSpec } from './types';
import { assertLocalEndpoint } from './types';

/**
 * 單次呼叫的逾時。
 *
 * 【實測數據，以及它為什麼不足以精算出一個數字】
 * 2026-08-16，qwen2.5:3b / Ryzen 5 3500U 走 CPU，同一批公告跑兩次：
 *   672 字 → 106.6 秒（冷啟動，含載入模型）／第二次 20.6 秒
 *   415 字 →  35.4 秒（同批冷啟動影響）／第二次  4.7 秒
 *   428 字 →  30.1 秒
 * **耗時與字數沒有乾淨的關係**，變異極大（同樣約 420 字，4.7 秒 vs 30.1 秒），
 * 所以無法由字數外推出一個「剛好夠用」的逾時。
 *
 * 已知的是實際公告說明長度：中位數 435 字、p90 872 字、**最長 3373 字**（123 則樣本），
 * 最長的是中位數的 8 倍。原本設的 120 秒，光是冷啟動加一則中等長度就快用完了。
 *
 * 因此這個 600 秒是**刻意抓寬的餘裕**，不是算出來的最佳值。
 * 取捨方向很明確：逾時的任務不會寫入結果、會一直留在待判狀態，
 * 形成一個安靜的缺口；寧可讓單筆慢，也不要讓它永遠判不到。
 */
export const DEFAULT_TIMEOUT_MS = 600_000;

export interface CompletionResult {
  readonly content: string;
  readonly latencyMs: number;
}

export class LlmProviderError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'LlmProviderError';
    this.status = status;
  }
}

/** 一次對話補全。回傳原始文字，不做任何解析——解析是 verdict.ts 的事 */
export interface ChatProvider {
  complete(system: string, user: string): Promise<CompletionResult>;
}

interface ChatChoice {
  readonly message?: { readonly content?: unknown };
}

export class OpenAiCompatibleProvider implements ChatProvider {
  readonly #spec: ModelSpec;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #now: () => number;

  constructor(
    spec: ModelSpec,
    options: {
      readonly fetchImpl?: typeof fetch;
      readonly timeoutMs?: number;
      readonly now?: () => number;
    } = {},
  ) {
    // 端點在建構時就檢查，而不是等到送出請求才檢查——
    // 錯的設定要在還沒對外連線之前就失敗。
    assertLocalEndpoint(spec.endpoint);
    this.#spec = spec;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  get url(): string {
    return `${this.#spec.endpoint.replace(/\/+$/, '')}/chat/completions`;
  }

  async complete(system: string, user: string): Promise<CompletionResult> {
    const started = this.#now();
    let res: Response;
    try {
      res = await this.#fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.#spec.modelKey,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          stream: false,
          ...INFERENCE_PARAMS,
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new LlmProviderError(
        `連不上本機模型端點 ${this.url}：${(error as Error).message}。` +
          '請確認 runtime 已啟動（Ollama 預設 11434、LM Studio 預設 1234）。',
        null,
      );
    }

    if (!res.ok) {
      throw new LlmProviderError(
        `模型端點回應 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`,
        res.status,
      );
    }

    const body = (await res.json()) as { choices?: readonly ChatChoice[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new LlmProviderError('模型回應缺少 choices[0].message.content', res.status);
    }
    return { content, latencyMs: this.#now() - started };
  }
}

/**
 * 假的 provider。給測試與 `--dry-run` 用，讓整條管線在沒有安裝任何 runtime 時
 * 仍然可以跑完並被驗證。
 *
 * ⚠️ 它**永遠回 no_veto**，因為一個假模型不該有能力否決任何東西。
 */
export class StubProvider implements ChatProvider {
  readonly #responses: readonly string[];
  #index = 0;

  constructor(responses: readonly string[] = []) {
    this.#responses = responses;
  }

  complete(): Promise<CompletionResult> {
    const canned =
      this.#responses[this.#index] ??
      JSON.stringify({ verdict: 'no_veto', quote: '', reason: 'stub provider，未實際推論' });
    this.#index += 1;
    return Promise.resolve({ content: canned, latencyMs: 0 });
  }
}
