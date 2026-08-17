/**
 * 從 L0 讀取快照供 L1 使用。
 *
 * 【讀取時一律重算 content_hash】
 * 帳本是不可變的，儲存層卻擋不住刪除（P4.5 實測）。
 * 每次讀取都比對雜湊，資料若被動過會在**使用前**就被抓到，
 * 而不是等到訊號算出來才發現源頭是壞的。
 */

import { sha256Hex } from '../l0/snapshot';
import type { SupabaseStorageBodyStore } from '../l0/supabase-storage';
import type { SourceId } from '../l0/types';

export interface SnapshotRef {
  readonly sourceId: SourceId;
  readonly dataAsOf: string | null;
  readonly dataPeriod: string | null;
  readonly bodyPath: string;
  readonly contentHash: string;
  readonly contentLength: number;
  readonly fetchedAt: string;
}

export interface LoadedSnapshot {
  readonly ref: SnapshotRef;
  readonly payload: unknown;
}

export class SnapshotIntegrityError extends Error {
  constructor(ref: SnapshotRef, actualHash: string) {
    super(
      `${ref.sourceId} 的原始資料與帳本不符：帳本 ${ref.contentHash}，實際 ${actualHash}。` +
        '資料可能已遺失或被竄改，在查清楚之前不得用於任何訊號計算。',
    );
    this.name = 'SnapshotIntegrityError';
  }
}

export interface LedgerReader {
  /** 取某來源最新一筆快照的帳本紀錄 */
  latestRef(sourceId: SourceId): Promise<SnapshotRef | null>;
  /** 取某來源在指定資料日期的帳本紀錄 */
  refByDate(sourceId: SourceId, dataAsOf: string): Promise<SnapshotRef | null>;
  /** 取某來源最近 `limit` 筆帳本紀錄，依寫入順序由新到舊 */
  recentRefs(sourceId: SourceId, limit: number): Promise<readonly SnapshotRef[]>;
}

/**
 * 每個 `data_as_of` 只留最新寫入的那一筆。
 *
 * 【為什麼需要這一步】
 * raw_snapshots 是 append-only：同一天重跑抓取就會多一列，內容相同也照存。
 * 要組「最近 N 個交易日」的序列時，若不先去重，
 * 重跑兩次的那天會佔掉兩個位置，回溯期間就少算一天——
 * 而 5 日反轉因子算錯期間不會報錯，只會靜默給出錯誤的數字。
 *
 * @param refsNewestFirst 依寫入順序由新到舊的帳本紀錄
 */
export function latestPerDate(refsNewestFirst: readonly SnapshotRef[]): readonly SnapshotRef[] {
  const seen = new Set<string>();
  const kept: SnapshotRef[] = [];
  for (const ref of refsNewestFirst) {
    if (ref.dataAsOf === null || seen.has(ref.dataAsOf)) {
      continue;
    }
    seen.add(ref.dataAsOf);
    kept.push(ref);
  }
  return kept;
}

/**
 * 帳本查詢一律排除「根本沒拿到資料」的快照。
 *
 * 【2026-08-16 事故：這一行是被真實事故逼出來的】
 * 那天 TWSE 對全部 11 個來源回 HTTP 200 加一頁封鎖頁，抓取層照存，
 * 於是 `latest()` 回傳的是 800 bytes 的 HTML，`JSON.parse` 直接爆掉。
 * 抓取層已補上格式檢查，但**那 11 列永遠留在資料庫裡**——
 * raw_snapshots 是 append-only，刪不掉也改不掉，這正是它的設計。
 * 所以讀取端必須自己會躲。
 *
 * ⚠️ 只排除 `invalid_json` 與 `payload_not_an_array` 這兩種。
 * `date_field_missing` / `date_unparsable` **不可**排除：
 * twse_margin_balance、twse_attention、twse_suspended、twse_altered_trading
 * 本來就沒有可解析的日期（L0 實測），那是正常資料，
 * L2 用「同一次抓取」規則處理。把它們一起排掉會讓否決層整個瞎掉。
 */
const UNUSABLE_FILTER = 'data_as_of_reason=not.in.(invalid_json,payload_not_an_array)';

export class SupabaseLedgerReader implements LedgerReader {
  readonly #url: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(url: string, apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.#url = url.replace(/\/+$/, '');
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
  }

  async #query(query: string, limit: number): Promise<readonly SnapshotRef[]> {
    const res = await this.#fetch(
      `${this.#url}/rest/v1/raw_snapshots?${query}` +
        '&select=source_id,data_as_of,data_period,body_path,content_hash,content_length,fetched_at' +
        `&body_store=eq.supabase_storage&${UNUSABLE_FILTER}&order=id.desc&limit=${limit}`,
      {
        headers: { apikey: this.#apiKey, Authorization: `Bearer ${this.#apiKey}` },
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!res.ok) {
      throw new Error(`讀取帳本失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const rows = (await res.json()) as {
      source_id: SourceId;
      data_as_of: string | null;
      data_period: string | null;
      body_path: string | null;
      content_hash: string;
      content_length: number;
      fetched_at: string;
    }[];
    return rows
      .filter((row) => row.body_path !== null)
      .map((row) => ({
        sourceId: row.source_id,
        dataAsOf: row.data_as_of,
        dataPeriod: row.data_period,
        bodyPath: row.body_path!,
        contentHash: row.content_hash,
        contentLength: row.content_length,
        fetchedAt: row.fetched_at,
      }));
  }

  async latestRef(sourceId: SourceId): Promise<SnapshotRef | null> {
    const rows = await this.#query(`source_id=eq.${encodeURIComponent(sourceId)}`, 1);
    return rows[0] ?? null;
  }

  async refByDate(sourceId: SourceId, dataAsOf: string): Promise<SnapshotRef | null> {
    const rows = await this.#query(
      `source_id=eq.${encodeURIComponent(sourceId)}&data_as_of=eq.${encodeURIComponent(dataAsOf)}`,
      1,
    );
    return rows[0] ?? null;
  }

  async recentRefs(sourceId: SourceId, limit: number): Promise<readonly SnapshotRef[]> {
    return this.#query(`source_id=eq.${encodeURIComponent(sourceId)}`, limit);
  }
}

export class SnapshotLoader {
  readonly #ledger: LedgerReader;
  readonly #storage: Pick<SupabaseStorageBodyStore, 'get'>;

  constructor(ledger: LedgerReader, storage: Pick<SupabaseStorageBodyStore, 'get'>) {
    this.#ledger = ledger;
    this.#storage = storage;
  }

  async #load(ref: SnapshotRef | null): Promise<LoadedSnapshot | null> {
    if (ref === null) {
      return null;
    }
    const bytes = await this.#storage.get(ref.bodyPath);
    const actual = sha256Hex(bytes);
    if (actual !== ref.contentHash) {
      throw new SnapshotIntegrityError(ref, actual);
    }
    return { ref, payload: JSON.parse(Buffer.from(bytes).toString('utf8')) };
  }

  async latest(sourceId: SourceId): Promise<LoadedSnapshot | null> {
    return this.#load(await this.#ledger.latestRef(sourceId));
  }

  async byDate(sourceId: SourceId, dataAsOf: string): Promise<LoadedSnapshot | null> {
    return this.#load(await this.#ledger.refByDate(sourceId, dataAsOf));
  }

  /**
   * 取最近 `days` 個**相異交易日**的快照，依日期升冪（最後一筆為最新）。
   *
   * 為了容納重跑造成的重複列，實際查詢筆數放大 `overFetch` 倍再去重。
   * 若去重後不足 `days` 天，就如實回傳較少的天數——不補、不猜。
   */
  async recentDays(
    sourceId: SourceId,
    days: number,
    overFetch = 4,
  ): Promise<readonly LoadedSnapshot[]> {
    const refs = latestPerDate(await this.#ledger.recentRefs(sourceId, days * overFetch)).slice(
      0,
      days,
    );
    const loaded: LoadedSnapshot[] = [];
    for (const ref of [...refs].reverse()) {
      const snapshot = await this.#load(ref);
      if (snapshot !== null) {
        loaded.push(snapshot);
      }
    }
    return loaded;
  }
}
