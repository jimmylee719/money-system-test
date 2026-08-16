/**
 * veto_events 的資料列組裝與寫入。
 *
 * 這一層刻意「薄」：不做任何判斷，只把 L2 引擎的決定搬進資料庫。
 * 規則本身在 rules.ts，守門在 SQL constraint。
 */

import type { PostgrestClient } from '../l0/supabase-store';
import type { RankedStock } from '../l1/factors/engine';
import type { VetoDecision, VetoResult } from './types';

export const VETO_EVENTS_TABLE = 'veto_events';

export interface VetoEventRow {
  readonly run_id: string;
  readonly data_as_of: string;
  readonly signal_at: string;
  readonly code: string;
  readonly market: string;
  readonly rule_id: string;
  readonly reason: string;
  readonly evidence: string;
  readonly rank_at_signal: number | null;
  readonly composite_score: number | null;
  readonly engine_version: string;
  readonly failed_closed: boolean;
}

export interface BuildVetoRowsInput {
  readonly result: VetoResult<RankedStock>;
  /** L1 的完整排序，用來查出被否決者當時的名次 */
  readonly ranked: readonly RankedStock[];
  readonly runId: string;
  readonly dataAsOf: string;
  readonly signalAt: string;
  readonly engineVersion: string;
}

/**
 * 把否決決定轉成資料列。純函式。
 *
 * `rank_at_signal` 由排序結果查出，呼叫端無法自行指定——
 * 否則就可以事後說「反正被擋掉的都是後段班」。
 */
export function buildVetoRows(input: BuildVetoRowsInput): readonly VetoEventRow[] {
  const byCode = new Map(input.ranked.map((s, i) => [s.code, { stock: s, rank: i + 1 }]));

  return input.result.vetoed.map((decision: VetoDecision) => {
    const hit = byCode.get(decision.code);
    return {
      run_id: input.runId,
      data_as_of: input.dataAsOf,
      signal_at: input.signalAt,
      code: decision.code,
      market: hit?.stock.market ?? 'TWSE',
      rule_id: decision.ruleId,
      reason: decision.reason,
      // evidence 不得為空（資料庫 constraint 也會擋）：
      // 沒有證據的否決等於沒有理由的否決，日後無法覆核
      evidence: decision.evidence.trim() === '' ? '（官方未提供說明文字）' : decision.evidence,
      rank_at_signal: hit?.rank ?? null,
      composite_score: hit?.stock.compositeScore ?? null,
      engine_version: input.engineVersion,
      failed_closed: input.result.failedClosed,
    };
  });
}

export class VetoEventWriter {
  readonly #client: PostgrestClient;

  constructor(client: PostgrestClient) {
    this.#client = client;
  }

  /**
   * 寫入否決紀錄。
   * 刻意不送 `inserted_at`——資料庫也沒有給應用程式該欄位的 INSERT 權限。
   * 0 筆否決是正常狀態（當日沒有任何注意處置股），不寫任何列。
   */
  async insert(rows: readonly VetoEventRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.#client.insert(VETO_EVENTS_TABLE, rows);
  }
}
