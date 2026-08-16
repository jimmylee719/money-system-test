/**
 * 把 L1 正規化後的列組成因子引擎要的 `FactorContext`。純函式。
 *
 * 【日期對齊在這裡強制，不在引擎裡】
 * 引擎假設它拿到的所有資料都屬於同一個交易日。
 * 那個假設必須在進引擎之前就被驗證——混到不同日期的資料不會報錯，
 * 只會安靜地產生前視偏誤。故 `alignDataAsOf` 對不上就直接拋錯。
 */

import type { DailyQuote, InstitutionalRow, MarginRow, MonthlyRevenueRow } from '../types';
import type { FactorContext } from './engine';
import { selectLatestRevenue } from './engine';

export class DataAsOfMismatchError extends Error {
  constructor(expected: string, mismatches: readonly { label: string; actual: string | null }[]) {
    super(
      `資料日期不一致，拒絕計算。基準日 ${expected}，但：\n` +
        mismatches.map((m) => `  ${m.label} = ${m.actual ?? '（無日期）'}`).join('\n') +
        '\n把不同交易日的資料混在一起排序即為前視偏誤，寧可不出榜也不出錯的榜。',
    );
    this.name = 'DataAsOfMismatchError';
  }
}

/**
 * 確認所有帶日期的來源都是同一個交易日。
 *
 * `twse_margin_balance` 的 payload 沒有日期欄位（實測），
 * 依已登記的 as_of_rule 由 L1 對應到行情的 data_as_of——
 * 該來源請不要放進這裡檢查，那是明確宣告過的推論，不是事實比對。
 */
export function alignDataAsOf(
  expected: string,
  dated: readonly { readonly label: string; readonly actual: string | null }[],
): void {
  const mismatches = dated.filter((d) => d.actual !== expected);
  if (mismatches.length > 0) {
    throw new DataAsOfMismatchError(expected, mismatches);
  }
}

function indexByCode<T extends { readonly code: string }>(
  rows: readonly T[],
): ReadonlyMap<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    map.set(row.code, row);
  }
  return map;
}

export interface BuildContextInput {
  readonly dataAsOf: string;
  /** 當日行情（TWSE + TPEx 合併） */
  readonly quotes: readonly DailyQuote[];
  readonly institutional: readonly InstitutionalRow[];
  readonly margin: readonly MarginRow[];
  /** 月營收，可含多期；選期規則由 selectLatestRevenue 依登記定義套用 */
  readonly monthlyRevenue: readonly MonthlyRevenueRow[];
  /**
   * 歷史行情，依交易日升冪，最後一筆必須是 `dataAsOf` 當日。
   * 每一筆是那一天的全市場行情（TWSE + TPEx 合併）。
   */
  readonly history: readonly { readonly date: string; readonly quotes: readonly DailyQuote[] }[];
}

export function buildFactorContext(input: BuildContextInput): FactorContext {
  const historyDates = input.history.map((d) => d.date);
  const last = historyDates[historyDates.length - 1];
  if (historyDates.length > 0 && last !== input.dataAsOf) {
    throw new Error(
      `歷史序列的最後一天是 ${last}，與基準日 ${input.dataAsOf} 不符。` +
        '回溯視窗的終點必須就是當日，否則五日反轉算的是別天的區間。',
    );
  }
  for (let i = 1; i < historyDates.length; i += 1) {
    if (historyDates[i - 1]! >= historyDates[i]!) {
      throw new Error(
        `歷史序列未依日期升冪或有重複：${historyDates[i - 1]} 之後是 ${historyDates[i]}`,
      );
    }
  }

  // 與 historyDates 逐位對齊；某檔某日無資料即為 null，不壓縮、不補值
  const historyByCode = new Map<string, (DailyQuote | null)[]>();
  input.history.forEach((day, dayIndex) => {
    for (const quote of day.quotes) {
      let series = historyByCode.get(quote.code);
      if (series === undefined) {
        series = new Array<DailyQuote | null>(historyDates.length).fill(null);
        historyByCode.set(quote.code, series);
      }
      series[dayIndex] = quote;
    }
  });

  return {
    dataAsOf: input.dataAsOf,
    quoteByCode: indexByCode(input.quotes),
    institutionalByCode: indexByCode(input.institutional),
    marginByCode: indexByCode(input.margin),
    revenueByCode: selectLatestRevenue(input.monthlyRevenue, input.dataAsOf),
    historyDates,
    historyByCode,
  };
}
