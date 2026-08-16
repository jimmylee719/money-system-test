/**
 * L2 否決層型別。
 *
 * 【L2 的鐵則：只能否決】（CLAUDE.md）
 * 這一層永遠只做一件事——把候選名單變短。它不排序、不加分、不產生新標的。
 * 這不是自律，是型別與測試共同保證的：`applyVetoes` 的輸出必定是輸入的子集合，
 * 且引擎在回傳前會實際比對一次，不符就拋錯。
 *
 * 【為什麼每一條否決都要留證據】
 * 一個把贏家全濾掉的否決層，比沒有否決層更糟。要判斷它到底幫了還是害了，
 * 必須知道「被擋掉的是哪些、為什麼、當時官方原文怎麼寫」。
 * 因此每筆否決都逐字保留官方原文，不改寫、不摘要。
 */

import type { L1Market } from '../l1/types';

/**
 * 否決規則識別碼。每條規則獨立記錄，
 * 這樣 P9/P12 才能分別衡量每一條的效果，而不是只知道「L2 整體」。
 */
export type VetoRuleId =
  /** 當日被交易所公布為注意股 */
  | 'attention'
  /** 處置期間涵蓋訊號日 */
  | 'disposition'
  /** 暫停交易且尚未恢復 */
  | 'suspended'
  /** 變更交易方法（全額交割）／分盤交易／管理股票／停止交易 */
  | 'altered_trading'
  /**
   * P11：本機 LLM 讀重大訊息原文後判定的負面事件。
   *
   * ⚠️ 這一條與其他四條性質不同，必須分開衡量：
   * 其他四條依據的是交易所公告的**事實**（有沒有被處置、有沒有暫停交易），
   * 這一條依據的是模型對文字的**判讀**，不可回測、可能出錯。
   * 之所以仍允許它存在，是因為它只能減少行動；
   * 之所以獨立成一條 rule_id，是為了日後能單獨把它關掉。
   */
  | 'llm_material_news'
  /** 否決所需的資料來源缺漏或不同批，無法判定 → 全面否決（fail-closed） */
  | 'source_unavailable';

/** 注意股 */
export interface AttentionRow {
  readonly code: string;
  readonly market: L1Market;
  /** 公布日。佔位列或格式異常時為 null。 */
  readonly date: string | null;
  /** 官方的注意原因原文，逐字保留 */
  readonly info: string;
}

/** 處置股 */
export interface DispositionRow {
  readonly code: string;
  readonly market: L1Market;
  /** 公告日 */
  readonly announcedDate: string | null;
  /** 處置起日（ISO）。無法解析時為 null。 */
  readonly periodStart: string | null;
  /** 處置迄日（ISO） */
  readonly periodEnd: string | null;
  /** 官方期間字串原文。兩個交易所格式不同，原樣保留以便稽核。 */
  readonly periodRaw: string;
  readonly reason: string;
  /** 處置措施（如「第一次處置」「人工管制撮合」）。上櫃無此欄位時為空字串。 */
  readonly measure: string;
}

/** 暫停交易 */
export interface SuspensionRow {
  readonly code: string;
  readonly market: L1Market;
  /** 暫停交易日（ISO） */
  readonly haltDate: string | null;
  /** 恢復交易日（ISO）。尚未公布恢復日時為 null。 */
  readonly resumptionDate: string | null;
  /** 官方原文，逐字保留 */
  readonly raw: string;
}

/**
 * 變更交易方法／分盤／管理股票／停止交易。
 *
 * TWSE 的 TWT85U 只有三個欄位，**列的存在本身**即代表該證券變更交易；
 * TPEx 的 tpex_cmode 則以多個全形 Ｙ 旗標區分狀態。兩者統一成這個型別。
 */
export interface AlteredTradingRow {
  readonly code: string;
  readonly market: L1Market;
  readonly date: string | null;
  /** 變更交易方法（全額交割） */
  readonly alteredTrading: boolean;
  /** 分盤集合競價 */
  readonly periodicTrading: boolean;
  /** 管理股票 */
  readonly managedStock: boolean;
  /** 停止交易 */
  readonly suspensionOfTrading: boolean;
  /** 官方旗標原文，逐字保留 */
  readonly raw: string;
}

/** 單一否決決定 */
export interface VetoDecision {
  readonly code: string;
  readonly ruleId: VetoRuleId;
  /** 給人看的一句話 */
  readonly reason: string;
  /** 官方原文或來源事實，逐字保留，不改寫不摘要 */
  readonly evidence: string;
}

export interface VetoResult<T> {
  /** 通過的候選，必定是輸入的子集合 */
  readonly passed: readonly T[];
  readonly vetoed: readonly VetoDecision[];
  /** ruleId → 被該規則擋下的檔數。同一檔可能觸發多條規則。 */
  readonly countsByRule: Readonly<Record<string, number>>;
  /** 因來源缺漏而全面否決時為 true —— 這是故障狀態，不是「今天沒訊號」 */
  readonly failedClosed: boolean;
}
