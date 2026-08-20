/**
 * 把 L0 快照組成 L2 引擎要的 `VetoContext`。純函式。
 *
 * 【日期對齊在這裡放寬，而且必須說清楚為什麼】
 * L1 要求所有來源的 data_as_of 完全相同，因為那些是**當日事實**（行情、籌碼），
 * 混到別天就是前視偏誤。
 *
 * L2 的來源不一樣，實測後有三種情況：
 *   1. 有交易日日期（tpex_altered_trading）→ 必須等於訊號日
 *   2. 是滾動視窗（twse/tpex_disposition、**tpex_attention**）→ 只要涵蓋訊號日即可
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
  MarginSuspensionRow,
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

/**
 * 注意股必須**只取訊號日當天的**。
 *
 * 【2026-08-18 實測修正：tpex_attention 是滾動視窗，不是單日檔】
 * 原本把它歸類成「有交易日日期 → data_as_of 必須等於訊號日」，
 * 實測發現同一份 payload 同時含 1150814（11 檔）與 1150817（17 檔）兩天，
 * 於是 inspectPayload 判為 multiple_dates_in_payload、data_as_of 為 null，
 * 來源檢查直接不通過 → L2 每個交易日都 fail-closed 全面否決。
 *
 * 但更嚴重的是另一件事：`checkAttention` 只看代號在不在名單裡、**不比對日期**。
 * 若不過濾就把兩天的列一起塞進索引，8/14 上榜、8/17 已經下榜的股票
 * 會被當成「當日被公布為注意股」擋掉——那不是保守，那是判斷錯誤。
 *
 * 【date 為 null 的列予以保留，這是刻意的】
 * twse_attention 當日無公告時只有一列全空的佔位列（正規化後 0 列），
 * 而它有實際公告時的日期欄位長相本系統尚無樣本。
 * 寧可保留 null 的列（其時效由「同一次抓取」規則把關），
 * 也不要因為一個沒驗證過的假設而讓 TWSE 的注意股整個失效。
 * 被丟掉的過期列數由 `staleAttentionCount` 回報，異常時看得見。
 */
export function attentionForSignalDate(
  rows: readonly AttentionRow[],
  signalDate: string,
): readonly AttentionRow[] {
  return rows.filter((row) => row.date === null || row.date === signalDate);
}

/** 因非訊號日而被排除的注意股列數。用於在報表上顯示，避免無聲丟資料。 */
export function staleAttentionCount(
  rows: readonly AttentionRow[],
  signalDate: string,
): number {
  return rows.length - attentionForSignalDate(rows, signalDate).length;
}

export interface BuildVetoContextInput {
  readonly signalDate: string;
  readonly attention: readonly AttentionRow[];
  readonly disposition: readonly DispositionRow[];
  readonly suspension: readonly SuspensionRow[];
  readonly alteredTrading: readonly AlteredTradingRow[];
  /**
   * P11.15 停資停券。**可省略** —— 這一條不 fail-closed，
   * 來源缺漏時傳空陣列或不傳，等同「今天沒有任何停券公告」而非「無法判斷」。
   * 其餘四個來源沒有這個待遇：缺一即全面否決。
   */
  readonly marginSuspension?: readonly MarginSuspensionRow[];
}

export function buildVetoContext(input: BuildVetoContextInput): VetoContext {
  return {
    signalDate: input.signalDate,
    // 只取訊號日當天的注意股；理由見 attentionForSignalDate
    attention: indexByCode(attentionForSignalDate(input.attention, input.signalDate)),
    // 同一檔可能有多筆不同期間的處置公告，全部保留逐一比對
    disposition: groupByCode(input.disposition),
    suspension: indexByCode(input.suspension),
    alteredTrading: indexByCode(input.alteredTrading),
    // 同一檔可能有多筆不同期間的停券公告，全部保留逐一比對。
    // 未提供時視為「沒有任何停券公告」——這一條不 fail-closed。
    marginSuspension: groupByCode(input.marginSuspension ?? []),
  };
}
