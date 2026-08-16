/**
 * P11 — 給本機模型的提示詞。**版本化且雜湊鎖定**。
 *
 * 【換 prompt 就是換模型】
 * 同一個模型配不同 prompt 是兩個不同的系統。因此 prompt 連同版本與雜湊
 * 一起寫進 model_registry，challenger 換了 prompt 就得重考 gold_set。
 * 沒有這條，「悄悄改一句提示詞讓成績變好」就無法被發現。
 *
 * 【這段提示詞刻意不問任何跟股價有關的事】
 * 沒有「這檔會漲會跌」、沒有「值不值得買」、沒有評分。
 * 只問一個是非題：這則公告有沒有陳述一件**已經發生**的具體負面事實。
 * 模型答得再好也產生不了買進訊號，因為根本沒問。
 *
 * 【不確定時倒向 no_veto，以及為什麼】
 * 這是刻意的偏誤，要說清楚代價：
 *   - 倒向 no_veto → 可能漏擋地雷。但 L3 的停損已把單筆虧損限制在 1R，
 *     真正的殘餘風險是跳空穿越停損。
 *   - 倒向 veto   → 可能把好機會全擋掉。而 LLM 的判斷不可回測，
 *     一個不可回測的元件若能大量否決，等於讓沒人能驗證的東西決定系統成敗。
 * 兩者都會被衡量：觀察榜不受 L2 影響，正是這一層的對照組（P9/P12）。
 * 若資料日後顯示這個方向錯了，改的是 prompt 版本，不是偷偷調一句話。
 */

import { createHash } from 'node:crypto';

import type { Announcement } from './types';

export const PROMPT_VERSION = 'veto-material-news-v1';

export const SYSTEM_PROMPT = [
  '你是台股公開資訊的閱讀助理。你的唯一工作是判讀一則「重大訊息」公告的原文，',
  '回答一個是非題：這則公告有沒有陳述一件已經發生、且對公司營運或財務明顯不利的具體事實。',
  '',
  '規則：',
  '1. 只依公告原文判斷。不得使用你對這家公司的任何既有印象或記憶。',
  '2. 不得預測股價、不得評價投資價值、不得給任何買賣建議。這些都不在問題範圍內。',
  '3. 判 veto 時必須逐字引用公告原文中的一小段作為依據（20～80 字）。',
  '   引用必須與原文完全一致，一個字都不能改寫或補字。',
  '4. 例行公告（財報公告、法說會、董事會決議通過一般議案、更正格式、',
  '   人事任免的例行異動、股利發放）不算不利事實，一律回 no_veto。',
  '5. 判斷不確定時回 no_veto。寧可漏擋，不可亂擋。',
  '',
  '只輸出一個 JSON 物件，不要有任何其他文字、不要用程式碼區塊：',
  '{"verdict":"veto 或 no_veto","quote":"逐字引用的原文片段，no_veto 時填空字串","reason":"一句話說明"}',
].join('\n');

/**
 * 使用者訊息。刻意**不含**公司名稱與代號——
 * 給了名稱，模型就會用它對這家公司的既有印象作答，而那既非原文也不可稽核。
 * 只給條款、主旨、說明三段原文。
 */
export function buildUserPrompt(item: Announcement): string {
  return [
    `【符合條款】${item.clause}`,
    `【主旨】${item.subject.trim()}`,
    '【說明】',
    item.detail.trim(),
  ].join('\n');
}

/** prompt 的雜湊。版本字串也納入，避免同內容不同版本被當成同一個 */
export const PROMPT_HASH = createHash('sha256')
  .update(`${PROMPT_VERSION}\n${SYSTEM_PROMPT}`, 'utf8')
  .digest('hex');

/**
 * 推論參數。temperature 0 是為了可重現——
 * 同一則公告每次跑出不同答案的系統，沒辦法拿來評分，也沒辦法稽核。
 * （注意：溫度 0 不保證完全決定性，不同 runtime 版本仍可能有差異，這點無法由本系統保證。）
 */
export const INFERENCE_PARAMS = {
  temperature: 0,
  top_p: 1,
  max_tokens: 400,
  seed: 11,
} as const;

export const PARAMS_HASH = createHash('sha256')
  .update(JSON.stringify(INFERENCE_PARAMS), 'utf8')
  .digest('hex');
