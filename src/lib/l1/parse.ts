/**
 * L1 數值解析。純函式。
 *
 * 【L0 與 L1 的分界】
 * L0 只存不判斷，官方給什麼就存什麼。所有「這個字串代表什麼意思」的解讀都在 L1，
 * 而且必須顯式、可測、可統計——不能靜默把解析失敗當成 0。
 *
 * 以下規則全部依 2026-08-16 實測的真實資料訂定，不是憑印象：
 *   - TPEx 行情 Close 有 5,202 筆為 `" ---"`（前導空格 + 三個減號）＝當日無成交
 *   - TPEx 行情 Change 帶尾隨空格與前導正號：`"-0.72 "`、`"+0.02"`
 *   - TWSE 本益比／殖利率有 214／235 筆為空字串＝該公司無此數值（如虧損無本益比）
 *   - TWSE 個股三大法人數字帶千分位逗號：`"250,897,716"`
 */

/** 解析過程的統計。缺值與解析失敗必須分開計數——前者正常，後者是警訊。 */
export interface ParseStats {
  /** 成功解析為數值 */
  parsed: number;
  /** 官方明示的缺值（空字串、`-`、`---`、`N/A`）——正常現象 */
  blank: number;
  /** 官方的非數值註記（如除權息日的漲跌欄）——有意義，不是缺值 */
  noted: number;
  /** 有內容但既非數值也非已知註記——格式可能變了，需要人看 */
  unparsable: number;
  /** 解析失敗的原始值樣本，最多保留 10 筆供診斷 */
  unparsableSamples: string[];
}

export function createParseStats(): ParseStats {
  return { parsed: 0, blank: 0, noted: 0, unparsable: 0, unparsableSamples: [] };
}

/** 官方表示「沒有數值」的樣態：空字串，或純粹由減號組成（`-`、`--`、`---`） */
const BLANK_RE = /^-*$/;

/**
 * 官方用來表示「沒有數值」的字面 token。
 * ⚠️ 只准放**已在真實資料中觀察到**的值。亂加會讓真正的格式變動被吞掉。
 *   `N/A`：上櫃本益比／殖利率／淨值比（2026-08-16 實測 218 筆）
 */
const BLANK_TOKENS: ReadonlySet<string> = new Set(['N/A', 'n/a']);

/**
 * 官方的非數值註記。**這些不是缺值，是資訊**。
 *   `除權`／`除息`／`除權息`：上櫃行情漲跌欄，該日辦理除權息
 *     （2026-08-16 實測 3 筆）。P9 計算報酬時必須把除權息還原，
 *     直接當缺值丟掉會低估報酬。
 */
const KNOWN_NOTES: ReadonlySet<string> = new Set(['除權', '除息', '除權息']);

export interface NumericOrNote {
  readonly value: number | null;
  /** 官方的非數值註記，逐字保留 */
  readonly note: string | null;
}

/**
 * 解析數值。
 * 回傳 null 代表「沒有數值」，呼叫端**不得**自行代換為 0——
 * 沒有本益比與本益比為 0 是完全不同的兩件事。
 */
export function parseNumeric(raw: unknown, stats?: ParseStats): number | null {
  if (raw === null || raw === undefined) {
    if (stats) stats.blank += 1;
    return null;
  }
  if (typeof raw === 'number') {
    if (Number.isFinite(raw)) {
      if (stats) stats.parsed += 1;
      return raw;
    }
    if (stats) stats.unparsable += 1;
    return null;
  }
  if (typeof raw !== 'string') {
    if (stats) stats.unparsable += 1;
    return null;
  }

  const trimmed = raw.trim();
  if (BLANK_RE.test(trimmed) || BLANK_TOKENS.has(trimmed)) {
    // "" / "-" / "--" / "---" / "N/A" 皆為官方的缺值表示
    if (stats) stats.blank += 1;
    return null;
  }

  // 去千分位逗號、去前導正號
  const cleaned = trimmed.replace(/,/g, '').replace(/^\+/, '');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) {
    if (stats) {
      stats.unparsable += 1;
      if (stats.unparsableSamples.length < 10) {
        stats.unparsableSamples.push(raw);
      }
    }
    return null;
  }
  if (stats) stats.parsed += 1;
  return value;
}

/** 解析整數。非整數視為解析失敗，不做四捨五入——股數不會有小數。 */
export function parseInteger(raw: unknown, stats?: ParseStats): number | null {
  const value = parseNumeric(raw, stats);
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value)) {
    if (stats) {
      stats.parsed -= 1;
      stats.unparsable += 1;
      if (stats.unparsableSamples.length < 10) {
        stats.unparsableSamples.push(String(raw));
      }
    }
    return null;
  }
  return value;
}

/**
 * 解析數值，並保留官方的非數值註記。
 *
 * 用於漲跌欄這種「平常是數字、特定日子是文字」的欄位。
 * 把註記當缺值丟掉會遺失資訊——除權息日的漲跌不是「沒有」，
 * 是「該日辦理除權息，漲跌不可直接比較」。
 */
export function parseNumericOrNote(raw: unknown, stats?: ParseStats): NumericOrNote {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (KNOWN_NOTES.has(trimmed)) {
      if (stats) stats.noted += 1;
      return { value: null, note: trimmed };
    }
  }
  return { value: parseNumeric(raw, stats), note: null };
}

/** 去除官方欄位值常見的前後空白（如上櫃證券名稱 `"主動統一升級50  "`） */
export function parseText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** 合併多個統計，供整批解析後彙總回報 */
export function mergeParseStats(...all: readonly ParseStats[]): ParseStats {
  const merged = createParseStats();
  for (const s of all) {
    merged.parsed += s.parsed;
    merged.blank += s.blank;
    merged.noted += s.noted;
    merged.unparsable += s.unparsable;
    for (const sample of s.unparsableSamples) {
      if (merged.unparsableSamples.length < 10) {
        merged.unparsableSamples.push(sample);
      }
    }
  }
  return merged;
}
