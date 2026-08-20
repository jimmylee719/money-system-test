/**
 * L2 否決規則。純函式，全部只依官方公告的事實判斷，沒有任何可調參數。
 *
 * 【每條規則獨立記錄的理由】
 * 一個把贏家全濾掉的否決層比沒有更糟。要知道每一條到底幫了還是害了，
 * 就必須分開記錄、分開衡量。P9 算 outcomes 時，被否決的標的一樣會被追蹤，
 * 因為觀察榜是照排名產生的、不受 L2 影響——那正是 L2 的對照組。
 *
 * 【注意股 vs 處置股，我對兩者的把握程度不同，誠實標示】
 * - 處置：確定成本。人工撮合每 2～5 分鐘一次、全額交割須預收全額款券，
 *   對數日至兩週的波段是實質的執行障礙。這條沒有爭議。
 * - 注意：警示而非限制。強勢股本來就容易因漲幅與週轉率被列注意，
 *   把它們全擋掉很可能連贏家一起擋掉。**這條是可疑的**，
 *   之所以仍實作，是因為連續注意會導致處置，而處置是確定成本。
 *   兩條分開記錄，就是為了日後用資料判斷這條該不該留。
 */

import type { DispositionRow, VetoDecision, VetoRuleId } from './types';
import type {
  AlteredTradingRow,
  AttentionRow,
  MarginSuspensionRow,
  SuspensionRow,
} from './types';

/** 規則的自我說明，會連同否決紀錄一起留存 */
export interface VetoRuleSpec {
  readonly id: VetoRuleId;
  readonly displayName: string;
  /** 為什麼這條規則只會減少行動，以及對它的把握程度 */
  readonly rationale: string;
  /** 'certain' = 確定的執行成本；'suspected' = 合理但未經資料驗證 */
  readonly confidence: 'certain' | 'suspected';
}

export const RULE_SPECS: readonly VetoRuleSpec[] = [
  {
    id: 'suspended',
    displayName: '暫停交易',
    rationale: '暫停交易期間根本無法成交，不是風險判斷而是事實：買不到就不能買。',
    confidence: 'certain',
  },
  {
    id: 'disposition',
    displayName: '處置股（處置期間內）',
    rationale:
      '處置期間以人工管制撮合（約每 2～5 分鐘一次）並可能須預收全額款券，' +
      '進出場都會有實質滑價與資金佔用，屬確定成本而非預測。',
    confidence: 'certain',
  },
  {
    id: 'altered_trading',
    displayName: '變更交易方法／分盤／管理股票／停止交易',
    rationale:
      '全額交割須預收全額款券、分盤交易撮合間隔拉長、管理股票流動性極差，' +
      '皆為交易所公告的交易條件變更，屬確定成本。',
    confidence: 'certain',
  },
  {
    id: 'attention',
    displayName: '注意股',
    rationale:
      '注意本身只是警示不是限制，強勢股本就容易因漲幅與週轉率被列注意，' +
      '此條有把贏家一併擋掉的風險。之所以保留，是因為連續注意會導致處置，' +
      '而處置是確定成本。獨立記錄，日後以資料判斷去留。',
    confidence: 'suspected',
  },
  {
    id: 'margin_suspension',
    displayName: '停資停券期間',
    rationale:
      '交易所停資停券的原因實測多為「股價波動過度劇烈」，那是交易所自己認定這檔目前不正常。' +
      '本系統不使用融資融券，故停券不影響我們的執行能力；擋它的理由是：' +
      '被認定波動過度的股票，其波動率估計本身就不可信，而我們用波動率算停損。' +
      '另外停券會抽掉市場槓桿資金、迫使融資戶平倉，那個賣壓與我們的進場理由無關。' +
      '**此條刻意不 fail-closed**：來源缺漏時放行，不讓一個我們根本不用的市場機制' +
      '決定今天有沒有訊號。',
    confidence: 'suspected',
  },
  {
    id: 'llm_material_news',
    displayName: '重大訊息負面事件（本機 LLM 判讀）',
    rationale:
      '本機模型讀重大訊息原文，判斷有無已發生的具體不利事實。' +
      '否決時必須逐字引用原文，引用在原文中找不到即作廢改判不否決——' +
      '幻覺不得構成否決依據。這條是所有規則裡把握程度最低的：' +
      '它依據的是模型對文字的判讀而非交易所公告的事實，不可回測，' +
      '因此獨立記錄、獨立衡量，並且可以單獨關閉。',
    confidence: 'suspected',
  },
  {
    id: 'source_unavailable',
    displayName: '否決所需資料缺漏（fail-closed）',
    rationale:
      '查不到某檔是否處置中，就不能當作它沒有處置。無法判定時一律否決，' +
      '寧可錯過也不要在不知情的狀況下進場。這是故障狀態，不是「今天沒訊號」。',
    confidence: 'certain',
  },
];

export const RULE_SPEC_BY_ID: ReadonlyMap<VetoRuleId, VetoRuleSpec> = new Map(
  RULE_SPECS.map((s) => [s.id, s]),
);

/** L2 判斷所需的當日事實 */
export interface VetoContext {
  /** 訊號日（＝排序所用資料的交易日） */
  readonly signalDate: string;
  readonly attention: ReadonlyMap<string, AttentionRow>;
  /** 同一檔可能有多筆處置公告（不同期間），故為陣列 */
  readonly disposition: ReadonlyMap<string, readonly DispositionRow[]>;
  readonly suspension: ReadonlyMap<string, SuspensionRow>;
  readonly alteredTrading: ReadonlyMap<string, AlteredTradingRow>;
  /**
   * P11.15 停資停券。同一檔可能有多筆不同期間的公告，故為陣列。
   * 來源缺漏時傳空 Map —— 這一條刻意不 fail-closed，理由見 types.ts 的 margin_suspension。
   */
  readonly marginSuspension: ReadonlyMap<string, readonly MarginSuspensionRow[]>;
}

// ── 個別規則 ─────────────────────────────────────────────────────────────────

export function checkSuspended(code: string, ctx: VetoContext): VetoDecision | null {
  const row = ctx.suspension.get(code);
  if (row === undefined) {
    return null;
  }
  // 已經恢復交易的就不再否決：恢復日在訊號日當天或之前即視為已恢復
  if (row.resumptionDate !== null && row.resumptionDate <= ctx.signalDate) {
    return null;
  }
  return {
    code,
    ruleId: 'suspended',
    reason: '交易所公告暫停交易且尚未恢復',
    evidence: row.raw,
  };
}

export function checkDisposition(code: string, ctx: VetoContext): VetoDecision | null {
  const rows = ctx.disposition.get(code);
  if (rows === undefined || rows.length === 0) {
    return null;
  }

  for (const row of rows) {
    // 期間解析失敗時**不放行**：查不到期間就等於不知道現在是否處置中，
    // 依 fail-closed 原則否決，並在證據裡標明是解析失敗而非確定處置中。
    if (row.periodStart === null || row.periodEnd === null) {
      return {
        code,
        ruleId: 'disposition',
        reason: '有處置公告但期間無法解析，無法確認是否仍在處置中',
        evidence: `期間原文「${row.periodRaw}」／原因「${row.reason}」`,
      };
    }
    if (row.periodStart <= ctx.signalDate && ctx.signalDate <= row.periodEnd) {
      return {
        code,
        ruleId: 'disposition',
        reason: `處置期間 ${row.periodStart} ~ ${row.periodEnd} 涵蓋訊號日`,
        evidence: `${row.measure === '' ? '' : `${row.measure}／`}原因「${row.reason}」／期間原文「${row.periodRaw}」`,
      };
    }
  }
  return null;
}

export function checkAlteredTrading(code: string, ctx: VetoContext): VetoDecision | null {
  const row = ctx.alteredTrading.get(code);
  if (row === undefined) {
    return null;
  }
  const flags: string[] = [];
  if (row.alteredTrading) flags.push('變更交易方法');
  if (row.periodicTrading) flags.push('分盤交易');
  if (row.managedStock) flags.push('管理股票');
  if (row.suspensionOfTrading) flags.push('停止交易');
  if (flags.length === 0) {
    // 上櫃的表會列出旗標全空的列，那代表這檔沒有任何交易條件變更
    return null;
  }
  return {
    code,
    ruleId: 'altered_trading',
    reason: flags.join('、'),
    evidence: row.raw,
  };
}

export function checkAttention(code: string, ctx: VetoContext): VetoDecision | null {
  const row = ctx.attention.get(code);
  if (row === undefined) {
    return null;
  }
  return {
    code,
    ruleId: 'attention',
    reason: '當日被交易所公布為注意股',
    evidence: row.info,
  };
}

/**
 * P11.15：停資停券期間涵蓋訊號日即否決。
 *
 * 【為什麼要擋，明明我們不用融資融券】
 * 交易所停資停券的原因欄實測多為「股價波動過度劇烈」——
 * 那是交易所自己在說這檔目前不正常。我們不用槓桿，但我們用波動率算停損；
 * 一檔被交易所認定波動過度的股票，其波動率估計本身就不可信。
 *
 * 更直接的理由：停資停券會抽掉市場上的槓桿資金，融資戶被迫平倉，
 * 那個賣壓與我們的進場理由無關，純粹是制度造成的。
 *
 * 【與其他四條的差別：來源缺漏時不 fail-closed】
 * 見 types.ts 的 margin_suspension。這裡只處理「清單拿得到」的情況。
 *
 * 【但期間解析失敗仍然否決】
 * 那只影響清單上真的有的那一檔，不會造成全面停機，
 * 且符合「只減不增」——查不到期間就等於不知道現在是否停券中。
 */
export function checkMarginSuspension(code: string, ctx: VetoContext): VetoDecision | null {
  const rows = ctx.marginSuspension.get(code);
  if (rows === undefined || rows.length === 0) {
    return null;
  }

  for (const row of rows) {
    if (row.periodStart === null || row.periodEnd === null) {
      return {
        code,
        ruleId: 'margin_suspension',
        reason: '有停資停券公告但期間無法解析，無法確認是否仍在停券中',
        evidence: `期間原文「${row.periodRaw}」／原因「${row.reason}」`,
      };
    }
    if (row.periodStart <= ctx.signalDate && ctx.signalDate <= row.periodEnd) {
      return {
        code,
        ruleId: 'margin_suspension',
        reason: `停資停券期間 ${row.periodStart} ~ ${row.periodEnd} 涵蓋訊號日`,
        evidence: `原因「${row.reason}」／期間原文「${row.periodRaw}」`,
      };
    }
  }
  return null;
}

/**
 * 全部規則，依「把握程度」由高到低排列。
 * 同一檔可能觸發多條，全部都會被記錄，不會只留第一條。
 */
export const VETO_CHECKS: readonly ((code: string, ctx: VetoContext) => VetoDecision | null)[] = [
  checkSuspended,
  checkDisposition,
  checkAlteredTrading,
  checkAttention,
  checkMarginSuspension,
];
