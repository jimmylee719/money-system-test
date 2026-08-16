/**
 * user_records 的資料列組裝與寫入。
 *
 * 【這張表記錄的是「人做了什麼」，不是「系統叫你做什麼」】
 * 系統的建議在 daily_picks。兩張表分開，才算得出 G4 的人工執行一致率。
 *
 * 【raw_text 一律逐字保留】
 * 解析可能出錯。留著原話，日後才有辦法回溯「當初到底打了什麼」。
 */

import type { PostgrestClient } from '../l0/supabase-store';
import type { RecCommand } from './line/commands';

export const USER_RECORDS_TABLE = 'user_records';

export interface UserRecordRow {
  readonly recorded_at: string;
  readonly data_as_of: string | null;
  readonly source: 'line' | 'manual';
  readonly line_message_id: string | null;
  readonly action: string;
  readonly code: string | null;
  readonly shares: number | null;
  readonly price: number | null;
  readonly note: string | null;
  readonly raw_text: string;
}

export interface BuildUserRecordInput {
  readonly command: RecCommand;
  /** LINE event 的 timestamp（毫秒）。用它而不是系統時鐘——那是使用者送出的時點。 */
  readonly recordedAtMs: number;
  /** 這筆決策對應哪一天的清單。取不到就留 null，不猜。 */
  readonly dataAsOf: string | null;
  readonly lineMessageId: string | null;
  readonly rawText: string;
}

export function buildUserRecordRow(input: BuildUserRecordInput): UserRecordRow {
  const { command } = input;
  return {
    recorded_at: new Date(input.recordedAtMs).toISOString(),
    data_as_of: input.dataAsOf,
    source: 'line',
    line_message_id: input.lineMessageId,
    action: command.action,
    code: command.code,
    shares: command.shares,
    price: command.price,
    note: command.note,
    raw_text: input.rawText,
  };
}

export class UserRecordWriter {
  readonly #client: PostgrestClient;

  constructor(client: PostgrestClient) {
    this.#client = client;
  }

  /**
   * 寫入一筆紀錄。
   * 刻意不送 `inserted_at`——資料庫也沒有給應用程式該欄位的 INSERT 權限。
   * 同一則 LINE 訊息重複送達會被唯一索引擋下（webhook 會重送）。
   */
  async insert(row: UserRecordRow): Promise<void> {
    await this.#client.insert(USER_RECORDS_TABLE, [row]);
  }
}

/** PostgREST 的唯一鍵衝突（webhook 重送時是正常狀況，不是錯誤） */
export function isDuplicateMessage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('23505') || message.includes('user_records_line_message_uniq');
}
