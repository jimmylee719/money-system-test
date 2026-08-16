/**
 * P11 — 解析模型回應，並驗證它引用的原文確實存在。
 *
 * 【引用驗證是「不捏造」鐵則的機器化執行】
 * 模型說「公告提到公司遭銀行拒絕往來」很有說服力，但如果原文根本沒這句話，
 * 那就是幻覺。人工逐則核對做不到，所以改成程式強制：
 * 否決必須附一段**在原文裡找得到**的引用，找不到就作廢改判 no_veto。
 *
 * 【比對前只移除空白，其他一律不動】
 * 官方原文裡有 \r\n、全形空格、對齊用的縮排，模型重述時幾乎不可能一字不差地保留，
 * 所以兩邊都先把空白全部去掉再比對。
 * 去空白不可能把一句原文沒有的話變成有——它放寬的是格式，不是內容。
 *
 * 但**標點與全形半形不做正規化**。模型若把「，」改成「,」就會驗不過而改判 no_veto。
 * 這個方向是安全的（退回不否決），而且驗不過的比例會被記錄下來，
 * 高到不合理時看得見，不會靜靜地爛掉。
 */

import type { Announcement, LlmVerdict, Verdict } from './types';

/** 引用至少要這麼長，否則「。」之類的字元也能通過比對 */
export const MIN_QUOTE_CHARS = 8;

export interface ParsedResponse {
  readonly ok: boolean;
  readonly verdict: Verdict;
  readonly quote: string;
  readonly reason: string;
  /** 解析失敗的原因，成功時為空字串 */
  readonly failure: string;
}

/** 去掉所有空白字元（含全形空格），只為了讓格式差異不影響比對 */
export function stripWhitespace(value: string): string {
  return value.replace(/[\s　﻿]+/gu, '');
}

/**
 * 從回應文字中取出第一個 JSON 物件。
 * 模型常會在 JSON 前後多寫幾句話或包上程式碼區塊，那是格式問題不是內容問題，
 * 容忍它；但值本身一律嚴格檢查。
 */
export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function parseResponse(raw: string): ParsedResponse {
  const blank: ParsedResponse = { ok: false, verdict: 'no_veto', quote: '', reason: '', failure: '' };
  const json = extractJsonObject(raw);
  if (json === null) {
    return { ...blank, failure: '回應中找不到 JSON 物件' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ...blank, failure: 'JSON 格式錯誤' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ...blank, failure: 'JSON 不是物件' };
  }
  const obj = parsed as Record<string, unknown>;
  const verdictRaw = typeof obj['verdict'] === 'string' ? obj['verdict'].trim() : '';

  // 只認這兩個字串。模型若自行發明第三種答案（例如 "buy"、"neutral"、"warning"），
  // 一律視為解析失敗——不猜它是什麼意思。
  if (verdictRaw !== 'veto' && verdictRaw !== 'no_veto') {
    return { ...blank, failure: `verdict 不是 veto/no_veto：${verdictRaw.slice(0, 40) || '(空)'}` };
  }
  return {
    ok: true,
    verdict: verdictRaw,
    quote: typeof obj['quote'] === 'string' ? obj['quote'] : '',
    reason: typeof obj['reason'] === 'string' ? obj['reason'].slice(0, 500) : '',
    failure: '',
  };
}

/** 引用是否確實出現在公告原文（主旨或說明）裡 */
export function verifyQuote(quote: string, item: Announcement): boolean {
  const needle = stripWhitespace(quote);
  if (needle.length < MIN_QUOTE_CHARS) {
    return false;
  }
  const haystack = stripWhitespace(`${item.subject}\n${item.detail}`);
  return haystack.includes(needle);
}

/**
 * 把原始回應收斂成一筆可寫入資料庫的判定。
 *
 * 這個函式是「只能否決」的最後一道程式閘門：
 * 它的回傳值在兩種情況下**必定**是 no_veto——解析失敗、引用驗不過。
 * 兩者都會如實記錄，不會被寫成「模型說沒問題」。
 */
export function toVerdict(
  taskKey: string,
  item: Announcement,
  rawResponse: string,
  latencyMs: number,
): LlmVerdict {
  const parsed = parseResponse(rawResponse);

  if (!parsed.ok) {
    return {
      taskKey,
      verdict: 'no_veto',
      quotedEvidence: '',
      evidenceVerified: false,
      parseOk: false,
      reason: `解析失敗：${parsed.failure}`,
      rawResponse,
      latencyMs,
    };
  }

  if (parsed.verdict === 'no_veto') {
    return {
      taskKey,
      verdict: 'no_veto',
      quotedEvidence: '',
      evidenceVerified: true,
      parseOk: true,
      reason: parsed.reason,
      rawResponse,
      latencyMs,
    };
  }

  const verified = verifyQuote(parsed.quote, item);
  if (!verified) {
    return {
      taskKey,
      verdict: 'no_veto',
      quotedEvidence: parsed.quote.slice(0, 500),
      evidenceVerified: false,
      parseOk: true,
      reason: `模型判否決但引用在原文中找不到，依「不捏造」原則作廢：${parsed.reason}`,
      rawResponse,
      latencyMs,
    };
  }

  return {
    taskKey,
    verdict: 'veto',
    quotedEvidence: parsed.quote.slice(0, 500),
    evidenceVerified: true,
    parseOk: true,
    reason: parsed.reason,
    rawResponse,
    latencyMs,
  };
}
