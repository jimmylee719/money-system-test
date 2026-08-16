/**
 * daily_picks 的資料列組裝與寫入。
 *
 * 這一層刻意「薄」：不做任何投資判斷，只把引擎算出來的結果搬進資料庫。
 * 真正的規則在 SQL constraint 與觸發器——程式可以被改，append-only 表改不了。
 */

import type { PostgrestClient } from '../l0/supabase-store';
import type { RankedStock, RankingResult } from './factors/engine';

export const DAILY_PICKS_TABLE = 'daily_picks';

/**
 * 兩份清單語意完全不同，不可混淆（CLAUDE.md）：
 *   watchlist    每日固定 5 檔，研究紀錄，**不是買進建議**
 *   trade_signal 通過 L2 否決與 L3 風控者，0～N 檔，經常是 0 檔
 */
export type PickListKind = 'watchlist' | 'trade_signal';

export interface DailyPickRow {
  readonly run_id: string;
  readonly revision: number;
  readonly data_as_of: string;
  readonly signal_at: string;
  readonly list_kind: PickListKind;
  readonly rank: number;
  readonly code: string;
  readonly market: string;
  readonly name: string;
  readonly price_at_push: number;
  readonly composite_score: number;
  readonly real_factor_count: number;
  readonly factor_scores: unknown;
  readonly engine_version: string;
  readonly active_factors: readonly string[];
  readonly inactive_factors: unknown;
  readonly universe_size: number;
  readonly tradable_count: number;
  readonly ranked_count: number;
}

export interface BuildPickRowsInput {
  readonly result: RankingResult;
  readonly stocks: readonly RankedStock[];
  readonly listKind: PickListKind;
  readonly runId: string;
  readonly revision: number;
  /** 產生清單當下的系統時鐘讀數（ISO） */
  readonly signalAt: string;
}

/**
 * 把排序結果轉成資料列。純函式。
 *
 * `rank` 由清單中的位置決定（1 起算），呼叫端無法自行指定——
 * 否則就可以事後把某一檔說成當時排第一。
 */
export function buildPickRows(input: BuildPickRowsInput): readonly DailyPickRow[] {
  const { result, stocks, listKind, runId, revision, signalAt } = input;
  return stocks.map((stock, i) => ({
    run_id: runId,
    revision,
    data_as_of: result.dataAsOf,
    signal_at: signalAt,
    list_kind: listKind,
    rank: i + 1,
    code: stock.code,
    market: stock.market,
    name: stock.name,
    price_at_push: stock.close,
    composite_score: stock.compositeScore,
    real_factor_count: stock.realFactorCount,
    factor_scores: stock.factorScores,
    engine_version: result.engineVersion,
    active_factors: result.activeFactors,
    inactive_factors: result.inactiveFactors,
    universe_size: result.universeSize,
    tradable_count: result.tradableCount,
    ranked_count: result.rankedCount,
  }));
}

export class DailyPicksWriter {
  readonly #client: PostgrestClient;

  constructor(client: PostgrestClient) {
    this.#client = client;
  }

  /**
   * 寫入清單。
   * 刻意不送 `inserted_at`——資料庫也沒有給應用程式該欄位的 INSERT 權限。
   * 同一天同一種清單的同一 revision 重複寫入會被唯一索引拒絕，這是刻意的。
   */
  async insert(rows: readonly DailyPickRow[]): Promise<void> {
    if (rows.length === 0) {
      return; // 交易訊號 0 檔是正常狀態，不需要寫任何列
    }
    await this.#client.insert(DAILY_PICKS_TABLE, rows);
  }
}
