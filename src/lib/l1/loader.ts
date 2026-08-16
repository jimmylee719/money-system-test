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
}

export class SupabaseLedgerReader implements LedgerReader {
  readonly #url: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(url: string, apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.#url = url.replace(/\/+$/, '');
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
  }

  async #query(query: string): Promise<SnapshotRef | null> {
    const res = await this.#fetch(
      `${this.#url}/rest/v1/raw_snapshots?${query}` +
        '&select=source_id,data_as_of,data_period,body_path,content_hash,content_length,fetched_at' +
        '&body_store=eq.supabase_storage&order=id.desc&limit=1',
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
    const row = rows[0];
    if (row === undefined || row.body_path === null) {
      return null;
    }
    return {
      sourceId: row.source_id,
      dataAsOf: row.data_as_of,
      dataPeriod: row.data_period,
      bodyPath: row.body_path,
      contentHash: row.content_hash,
      contentLength: row.content_length,
      fetchedAt: row.fetched_at,
    };
  }

  async latestRef(sourceId: SourceId): Promise<SnapshotRef | null> {
    return this.#query(`source_id=eq.${encodeURIComponent(sourceId)}`);
  }

  async refByDate(sourceId: SourceId, dataAsOf: string): Promise<SnapshotRef | null> {
    return this.#query(
      `source_id=eq.${encodeURIComponent(sourceId)}&data_as_of=eq.${encodeURIComponent(dataAsOf)}`,
    );
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
}
