/**
 * 把 L0 快照組成 L2 引擎要的 `VetoContext`。純函式。
 *
 * 【日期對齊在這裡放寬，而且必須說清楚為什麼】
 * L1 要求所有來源的 data_as_of 完全相同，因為那些是**當日事實**（行情、籌碼），
 * 混到別天就是前視偏誤。
 *
 * L2 的來源不一樣，實測後有三種情況：
 *   1. 有交易日日期（tpex_attention / tpex_altered_trading）→ 必須等於訊號日
 *   2. 是滾動視窗（twse/tpex_disposition，一次回傳近期多日）→ 只要涵蓋訊號日即可
 *   3. **完全沒有日期欄位**（twse_suspended / twse_altered_trading）
 *      或當日無公告而只有佔位列（twse_attention）
 *      → 只能以「與行情同一次抓取」判定，與 twse_margin_balance 同樣的處理
 *
 * 第 3 種是事實上的限制，不是偷懶。誠實的做法是把它寫成明確規則並記錄，
 * 而不是假裝那些 payload 有日期。
 */

import type { SnapshotRef } from '../l1/loader';
import type { VetoContext } from './rules';
import type {
  AlteredTradingRow,
  AttentionRow,
  DispositionRow,
  SuspensionRow,
} from './types';

/**
 * 「同一次抓取」的判定門檻。每日排程相隔 24 小時，
 * 6 小時足以涵蓋重試，又不可能把前一天的檔案誤認成今天的。
 * 與 generate-picks.ts 對 twse_margin_balance 的處理一致。
 */
export const SAME_RUN_TOLERANCE_MS = 6 * 60 * 60 * 1000;

export class VetoSourceStaleError extends Error {
  constructor(sourceId: string, detail: string) {
    super(
      `L2 來源 ${sourceId} 無法確認屬於本次抓取：${detail}。` +
        '否決層的資料若不是當批的，等於用昨天的限制判斷今天——寧可 fail-closed。',
    );
    this.name = 'VetoSourceStaleError';
  }
}

/**
 * 判定一個「無日期或當日無公告」的來源是否與行情同一次抓取。
 * 回傳相差的毫秒數；超過門檻由呼叫端決定 fail-closed。
 */
export function fetchGapMs(ref: SnapshotRef, reference: SnapshotRef): number {
  return Math.abs(Date.parse(ref.fetchedAt) - Date.parse(reference.fetchedAt));
}

export function isSameRun(ref: SnapshotRef, reference: SnapshotRef): boolean {
  return fetchGapMs(ref, reference) <= SAME_RUN_TOLERANCE_MS;
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

function groupByCode<T extends { readonly code: string }>(
  rows: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.code);
    if (list === undefined) {
      map.set(row.code, [row]);
    } else {
      list.push(row);
    }
  }
  return map;
}

export interface BuildVetoContextInput {
  readonly signalDate: string;
  readonly attention: readonly AttentionRow[];
  readonly disposition: readonly DispositionRow[];
  readonly suspension: readonly SuspensionRow[];
  readonly alteredTrading: readonly AlteredTradingRow[];
}

export function buildVetoContext(input: BuildVetoContextInput): VetoContext {
  return {
    signalDate: input.signalDate,
    attention: indexByCode(input.attention),
    // 同一檔可能有多筆不同期間的處置公告，全部保留逐一比對
    disposition: groupByCode(input.disposition),
    suspension: indexByCode(input.suspension),
    alteredTrading: indexByCode(input.alteredTrading),
  };
}
