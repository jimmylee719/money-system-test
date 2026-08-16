/**
 * LINE Messaging API 用戶端。零執行期依賴，直接用原生 fetch。
 *
 * ⚠️ 本模組**永遠不會把憑證內容放進錯誤訊息、回傳值或任何 log**。
 *    需要診斷時只回報長度與 HTTP 狀態碼。
 *
 * 【只送不收】
 * 推播是 outbound，GitHub Actions 就能做，不需要對外開 port。
 * 接收訊息（webhook）需要一個對外端點，那是另一支程式（Supabase Edge Function），
 * 兩者刻意分開：日報壞掉不影響紀錄，反之亦然。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** 官方限制：單則文字訊息 5000 字，單次請求最多 5 則 */
export const LINE_TEXT_LIMIT = 5000;
export const LINE_MESSAGES_PER_REQUEST = 5;

const PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';

export class LineApiError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    // body 由 LINE 回傳，不含我方憑證
    super(`LINE API 回應 ${status}：${body.slice(0, 300)}`);
    this.name = 'LineApiError';
    this.status = status;
  }
}

export interface LineClientOptions {
  readonly channelAccessToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class LineClient {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: LineClientOptions) {
    this.#token = options.channelAccessToken;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  /**
   * 推播文字訊息。
   *
   * 超過單則字數上限時**拆成多則**而不是截斷——
   * 日報被截斷會讓最後幾檔悄悄消失，那比訊息長更糟。
   */
  async pushText(to: string, text: string): Promise<void> {
    const chunks = splitForLine(text);
    if (chunks.length > LINE_MESSAGES_PER_REQUEST) {
      throw new LineApiError(
        0,
        `訊息拆成 ${chunks.length} 則，超過單次上限 ${LINE_MESSAGES_PER_REQUEST} 則。請縮短內容。`,
      );
    }
    const res = await this.#fetch(PUSH_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to,
        messages: chunks.map((chunk) => ({ type: 'text', text: chunk })),
      }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) {
      throw new LineApiError(res.status, await res.text());
    }
  }
}

/**
 * 依 LINE 的字數上限切分文字，**在換行處切**，不切在字中間。
 * 單行本身就超長時才硬切。
 */
export function splitForLine(text: string, limit = LINE_TEXT_LIMIT): readonly string[] {
  if (text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let current = '';

  for (const line of text.split('\n')) {
    // 單行超長：先把累積的送出，再硬切這一行
    if (line.length > limit) {
      if (current !== '') {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += limit) {
        chunks.push(line.slice(i, i + limit));
      }
      continue;
    }
    const candidate = current === '' ? line : `${current}\n${line}`;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current !== '') {
    chunks.push(current);
  }
  return chunks;
}

/**
 * 驗證 LINE webhook 簽章。
 *
 * 【為什麼一定要驗】
 * webhook 端點是公開的，任何人都能對它送 POST。
 * 不驗簽章等於任何人都可以偽造「你說你買了某檔」寫進 user_records，
 * 而 user_records 是 append-only —— 假資料進去就永遠拔不掉。
 *
 * 演算法為 HMAC-SHA256（金鑰＝channel secret）後做 base64，
 * 與 `X-Line-Signature` 標頭比對。比對用 timingSafeEqual 避免時序攻擊。
 *
 * @param rawBody **未經解析的原始 body 字串**。用 JSON.parse 再 stringify
 *                會改變空白與鍵序，簽章必定對不上。
 */
export function verifyLineSignature(
  rawBody: string,
  signature: string | null,
  channelSecret: string,
): boolean {
  if (signature === null || signature === '') {
    return false;
  }
  const expected = createHmac('sha256', channelSecret).update(rawBody, 'utf8').digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  if (received.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(expected, received);
}
