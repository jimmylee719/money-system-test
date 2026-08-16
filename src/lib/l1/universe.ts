/**
 * 標的池（universe）。純函式。
 *
 * 【為什麼不能用代號正則判斷】
 * 直覺做法是「4 碼純數字＝股票」。2026-08-16 實測證明這是錯的：
 *   - 上市公司基本資料 1,095 檔中有 6 檔是 6 碼代號
 *     （910322、911608…第一上市外國公司），正則會漏掉
 *   - 0050 是 4 碼純數字，但它是 ETF 不是公司，正則會誤收
 *   - 櫃買行情表 10,489 列中有 9,141 列是權證，若不過濾會拿權證去排序
 *
 * 交易所自己維護的**公司名冊**才是唯一依據：
 * 出現在 `mops_*_company_profile` 的代號＝真正的上市／上櫃公司。
 * 這是事實查詢，不是規則猜測。
 */

import type { DailyQuote, L1Market, UniverseEntry } from './types';

export interface Universe {
  /** code → 公司資料 */
  readonly byCode: ReadonlyMap<string, UniverseEntry>;
  readonly size: number;
}

export function buildUniverse(entries: readonly UniverseEntry[]): Universe {
  const byCode = new Map<string, UniverseEntry>();
  for (const entry of entries) {
    byCode.set(entry.code, entry);
  }
  return { byCode, size: byCode.size };
}

/** 合併多個市場的名冊 */
export function mergeUniverses(...universes: readonly Universe[]): Universe {
  const byCode = new Map<string, UniverseEntry>();
  for (const u of universes) {
    for (const [code, entry] of u.byCode) {
      byCode.set(code, entry);
    }
  }
  return { byCode, size: byCode.size };
}

export function isInUniverse(universe: Universe, code: string): boolean {
  return universe.byCode.has(code);
}

export interface UniverseFilterResult<T> {
  readonly kept: readonly T[];
  /** 被排除的列數（權證、ETF、特別股等非公司標的） */
  readonly excluded: number;
  /** 在名冊上但當日沒有這筆資料的代號（暫停交易、無成交等） */
  readonly missingFromData: readonly string[];
}

/**
 * 以標的池過濾任何帶 code 的列。
 *
 * 同時回報「名冊上有但資料裡沒有」的代號——那通常代表暫停交易或當日無成交，
 * 是需要知道的事實，不該靜默忽略。
 */
export function filterToUniverse<T extends { readonly code: string }>(
  universe: Universe,
  rows: readonly T[],
): UniverseFilterResult<T> {
  const kept: T[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (universe.byCode.has(row.code)) {
      kept.push(row);
      seen.add(row.code);
    }
  }

  const missingFromData: string[] = [];
  for (const code of universe.byCode.keys()) {
    if (!seen.has(code)) {
      missingFromData.push(code);
    }
  }

  return { kept, excluded: rows.length - kept.length, missingFromData: missingFromData.sort() };
}

/**
 * 可交易性檢查：當日有收盤價且有成交量。
 *
 * 這是**事實判定**（有沒有成交），不是投資判斷。
 * 流動性門檻等會影響行動的判斷屬於 L2 否決層，不在這裡。
 */
export function isTradable(quote: DailyQuote): boolean {
  return quote.close !== null && quote.close > 0 && (quote.volumeShares ?? 0) > 0;
}

export interface UniverseSummary {
  readonly market: L1Market | 'ALL';
  readonly universeSize: number;
  readonly withQuote: number;
  readonly tradable: number;
  readonly excludedFromQuotes: number;
}

export function summarizeUniverse(
  universe: Universe,
  quotes: readonly DailyQuote[],
  market: L1Market | 'ALL' = 'ALL',
): UniverseSummary {
  const filtered = filterToUniverse(universe, quotes);
  return {
    market,
    universeSize: universe.size,
    withQuote: filtered.kept.length,
    tradable: filtered.kept.filter(isTradable).length,
    excludedFromQuotes: filtered.excluded,
  };
}
