/**
 * P11 — LLM 否決層型別。
 *
 * 【這一整個模組只能做一件事：把候選名單變短】（CLAUDE.md 第四條鐵則）
 * 保證方式有四層，而且沒有一層是靠自律：
 *   1. 型別      `Verdict = 'veto' | 'no_veto'`，沒有第三個值可寫
 *   2. 資料庫    `llm_results.verdict` 的 check constraint 同樣只有兩值
 *   3. 執行期    套用時走與 P6 相同的 `assertOnlySubtracts`
 *   4. 引用驗證  否決必須引用原文的真實片段，引用不到就作廢
 *
 * 想讓 LLM 產生一個買進訊號，得先改型別、改 migration、改引擎、改測試。
 * 那不是不可能，但不可能「不小心」發生。
 *
 * 【為什麼解析失敗要判 no_veto，而不是 fail-closed 的 veto】
 * P6 的規則式否決缺資料時全面否決（fail-closed），因為那些是官方事實，
 * 查不到就是「今天無法判斷交易狀態」。
 * LLM 不一樣——它是**選配**的、不可回測的元件。
 * 若讓它壞掉就全部擋掉，等於把系統的停機權交給一個沒人能驗證的東西。
 * 壞掉時應該退回「沒有 LLM 的狀態」，也就是不否決；
 * 但必須留下 parse_ok=false 的紀錄，並在日報上明說今天有幾筆沒判成。
 */

import type { L1Market } from '../../l1/types';

/**
 * 判定結果。**只有兩個值。**
 * 這裡沒有 'buy'、沒有 'strong'、沒有分數可以被下游當成買進理由。
 */
export type Verdict = 'veto' | 'no_veto';

/** 模型在系統中的角色。禁止熱抽換：challenger 要勝過 champion 才能晉升 */
export type ModelRole = 'champion' | 'challenger';

export type LlmProviderKind = 'ollama' | 'lmstudio' | 'openai_compatible';

/** 一則重大訊息公告，逐字保留官方原文 */
export interface Announcement {
  readonly sourceId: string;
  readonly code: string;
  readonly market: L1Market;
  /** 發言日期（ISO）。事件時點，不是抓取時點 */
  readonly speakDate: string;
  /** 符合條款，如「第51款」。官方原文照抄，本系統不解釋條款含義 */
  readonly clause: string;
  /** 主旨原文 */
  readonly subject: string;
  /** 說明原文 */
  readonly detail: string;
  /** 公告內容的 SHA-256 */
  readonly contentHash: string;
  /** {market}:{code}:{speakDate}:{contentHash 前 12 碼} */
  readonly itemKey: string;
}

/** 待判任務＝公告 + 它要影響哪一天的訊號 */
export interface LlmTask extends Announcement {
  readonly taskKey: string;
  readonly dataAsOf: string;
}

/** 模型登記。prompt 換了就是換一個模型，必須重新評分 */
export interface ModelSpec {
  readonly modelKey: string;
  readonly provider: LlmProviderKind;
  /** 只准本機端點。CLAUDE.md：零 AI API 支出、僅 outbound */
  readonly endpoint: string;
  readonly role: ModelRole;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly paramsHash: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** 已登記在 model_registry 的模型（含資料庫 id） */
export interface RegisteredModel extends ModelSpec {
  readonly id: number;
  readonly registeredAt: string;
  readonly goldAccuracy: number | null;
  readonly goldSampleSize: number | null;
  readonly goldSetHash: string | null;
}

/** 一次判定的結果 */
export interface LlmVerdict {
  readonly taskKey: string;
  readonly verdict: Verdict;
  /** 模型引用的原文片段，必須是 subject/detail 的真實子字串 */
  readonly quotedEvidence: string;
  /** 引用是否通過原文比對。false 時 verdict 必為 no_veto */
  readonly evidenceVerified: boolean;
  /** 回應是否解析成功。false 時 verdict 必為 no_veto */
  readonly parseOk: boolean;
  readonly reason: string;
  /** 原始回應全文，逐字保留 */
  readonly rawResponse: string;
  readonly latencyMs: number;
}

/** gold_set 的一題 */
export interface GoldItem extends Announcement {
  readonly label: Verdict;
  readonly labelReason: string;
  readonly labeledBy: string;
  readonly revision: number;
}

/** 本機端點的白名單。非本機一律拒絕登記，避免意外連上要付費的 API */
export const LOCAL_ENDPOINT_PATTERN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/.*)?$/;

export class NonLocalEndpointError extends Error {
  constructor(endpoint: string) {
    super(
      `LLM 端點必須是本機：${endpoint} 不符合。` +
        'CLAUDE.md 規定本專案零 AI API 支出、worker 僅 outbound 不開 inbound port，' +
        '允許外部端點等於允許意外計費。',
    );
    this.name = 'NonLocalEndpointError';
  }
}

export function assertLocalEndpoint(endpoint: string): void {
  if (!LOCAL_ENDPOINT_PATTERN.test(endpoint)) {
    throw new NonLocalEndpointError(endpoint);
  }
}
