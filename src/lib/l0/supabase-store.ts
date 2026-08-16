/**
 * Supabase 儲存實作。
 *
 * 分工：
 *   原始 bytes → 委派給既有的檔案儲存（日後換 Cloudflare R2，此處不動）
 *   帳本／健康度 → 寫入 Supabase 的 raw_snapshots 與 source_health
 *
 * 抓取層（fetcher / ingest）完全不知道有 Supabase —— 這是 P1 就預留好的 SnapshotStore 埠。
 *
 * 只用原生 fetch 打 PostgREST，不引入 @supabase/supabase-js：
 * 我們只需要 INSERT 與 SELECT，一個 200 行不到的模組足夠，且維持零執行期依賴。
 */

import type {
  BodyStore,
  BodyStoreKind,
  ManifestEntry,
  PutResult,
  RawSnapshot,
  SnapshotStore,
} from './types';

/**
 * source_health 的狀態。判定順序由嚴重到輕微，第一個成立者勝出：
 *   fetch_failed > schema_drift > heterogeneous_rows > date_unresolved > ok
 */
export type SourceHealthStatus =
  | 'ok'
  | 'schema_drift'
  | 'heterogeneous_rows'
  | 'date_unresolved'
  | 'fetch_failed';

export interface RawSnapshotRow {
  readonly source_id: string;
  readonly url: string;
  readonly market: string;
  readonly source_tier: string;
  readonly data_as_of: string | null;
  readonly data_as_of_reason: string;
  readonly data_period: string | null;
  readonly fetched_at: string;
  readonly content_hash: string;
  readonly content_length: number;
  readonly body_store: BodyStoreKind;
  readonly body_path: string | null;
  /** 壓縮後實際佔用大小。content_length 為壓縮前，兩者不可混用。 */
  readonly body_bytes: number | null;
  readonly observed_fields: readonly string[] | null;
  readonly observed_data_dates: readonly string[];
  readonly observed_data_periods: readonly string[];
  readonly row_count: number | null;
  readonly heterogeneous_row_count: number | null;
  readonly http_status: number;
  readonly etag: string | null;
  readonly last_modified: string | null;
  readonly duration_ms: number;
  readonly attempt: number;
}

export interface SourceHealthRow {
  readonly source_id: string;
  readonly observed_at: string;
  readonly status: SourceHealthStatus;
  readonly http_status: number | null;
  readonly content_hash: string | null;
  readonly fields_added: readonly string[];
  readonly fields_removed: readonly string[];
  readonly row_count: number | null;
  readonly heterogeneous_row_count: number | null;
  readonly data_as_of_reason: string | null;
  readonly error: string | null;
}

// ── 純函式對映（可離線測試） ──────────────────────────────────────────────────

export function toRawSnapshotRow(
  snapshot: RawSnapshot,
  bodyPath: string | null,
  bodyStore: BodyStoreKind,
  storedBytes: number | null = null,
): RawSnapshotRow {
  return {
    source_id: snapshot.sourceId,
    url: snapshot.url,
    market: snapshot.market,
    source_tier: snapshot.sourceTier,
    data_as_of: snapshot.dataAsOf,
    data_as_of_reason: snapshot.dataAsOfReason,
    data_period: snapshot.dataPeriod,
    fetched_at: snapshot.fetchedAt,
    content_hash: snapshot.contentHash,
    content_length: snapshot.contentLength,
    body_store: bodyStore,
    body_path: bodyPath,
    body_bytes: storedBytes,
    observed_fields: snapshot.observedFields,
    observed_data_dates: snapshot.observedDataDates,
    observed_data_periods: snapshot.observedDataPeriods,
    row_count: snapshot.rowCount,
    heterogeneous_row_count: snapshot.heterogeneousRowCount,
    http_status: snapshot.httpStatus,
    etag: snapshot.etag,
    last_modified: snapshot.lastModified,
    duration_ms: snapshot.durationMs,
    attempt: snapshot.attempt,
  };
}

export function deriveHealthStatus(entry: ManifestEntry): SourceHealthStatus {
  if (entry.status === 'failed' || entry.snapshot === null) {
    return 'fetch_failed';
  }
  if (entry.fieldsAdded.length > 0 || entry.fieldsRemoved.length > 0) {
    return 'schema_drift';
  }
  if ((entry.snapshot.heterogeneousRowCount ?? 0) > 0) {
    return 'heterogeneous_rows';
  }
  if (entry.snapshot.dataAsOf === null) {
    return 'date_unresolved';
  }
  return 'ok';
}

export function toSourceHealthRow(entry: ManifestEntry): SourceHealthRow {
  return {
    source_id: entry.sourceId,
    observed_at: entry.fetchedAt,
    status: deriveHealthStatus(entry),
    http_status: entry.snapshot?.httpStatus ?? null,
    content_hash: entry.contentHash,
    fields_added: entry.fieldsAdded,
    fields_removed: entry.fieldsRemoved,
    row_count: entry.snapshot?.rowCount ?? null,
    heterogeneous_row_count: entry.snapshot?.heterogeneousRowCount ?? null,
    data_as_of_reason: entry.snapshot?.dataAsOfReason ?? null,
    error: entry.error,
  };
}

// ── PostgREST 用戶端 ─────────────────────────────────────────────────────────

export interface PostgrestClient {
  insert(table: string, rows: readonly unknown[]): Promise<void>;
  count(table: string): Promise<number>;
}

export class PostgrestError extends Error {
  readonly status: number;
  readonly table: string;

  constructor(table: string, status: number, body: string) {
    super(`PostgREST ${table} 回應 ${status}：${body.slice(0, 300)}`);
    this.name = 'PostgrestError';
    this.status = status;
    this.table = table;
  }
}

export interface PostgrestOptions {
  readonly url: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class Postgrest implements PostgrestClient {
  readonly #url: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: PostgrestOptions) {
    this.#url = options.url.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.#apiKey,
      Authorization: `Bearer ${this.#apiKey}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  async insert(table: string, rows: readonly unknown[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const res = await this.#fetch(`${this.#url}/rest/v1/${table}`, {
      method: 'POST',
      headers: this.#headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify(rows),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) {
      throw new PostgrestError(table, res.status, await res.text());
    }
  }

  async count(table: string): Promise<number> {
    const res = await this.#fetch(`${this.#url}/rest/v1/${table}?select=id&limit=1`, {
      method: 'GET',
      headers: this.#headers({ Prefer: 'count=exact', Range: '0-0' }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) {
      throw new PostgrestError(table, res.status, await res.text());
    }
    // Content-Range 形如 "0-0/123"
    const total = (res.headers.get('content-range') ?? '').split('/')[1] ?? '';
    const parsed = Number.parseInt(total, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
}

// ── 組合式 SnapshotStore ─────────────────────────────────────────────────────

export const RAW_SNAPSHOTS_TABLE = 'raw_snapshots';
export const SOURCE_HEALTH_TABLE = 'source_health';

/**
 * 原始 bytes 交給 `bodyStore`（本機檔案或 Supabase Storage），
 * 帳本與健康度寫進 Postgres。
 *
 * `localManifest` 為選配的本機 manifest 備份：
 * 在自己電腦上跑時保留，可與資料庫互相稽核；
 * 在 GitHub Actions 上跑時檔案系統是拋棄式的，傳 null 即可。
 */
export class SupabaseSnapshotStore implements SnapshotStore {
  readonly #bodyStore: BodyStore;
  readonly #client: PostgrestClient;
  readonly #localManifest: SnapshotStore | null;

  constructor(
    bodyStore: BodyStore,
    client: PostgrestClient,
    localManifest: SnapshotStore | null = null,
  ) {
    this.#bodyStore = bodyStore;
    this.#client = client;
    this.#localManifest = localManifest;
  }

  get bodyStoreKind(): BodyStoreKind {
    return this.#bodyStore.kind;
  }

  async put(snapshot: RawSnapshot, body: Uint8Array): Promise<PutResult> {
    return this.#bodyStore.put(snapshot, body);
  }

  async appendManifest(entry: ManifestEntry): Promise<void> {
    if (this.#localManifest !== null) {
      await this.#localManifest.appendManifest(entry);
    }

    if (entry.snapshot !== null) {
      await this.#client.insert(RAW_SNAPSHOTS_TABLE, [
        toRawSnapshotRow(entry.snapshot, entry.bodyPath, this.#bodyStore.kind, entry.storedBytes),
      ]);
    }
    await this.#client.insert(SOURCE_HEALTH_TABLE, [toSourceHealthRow(entry)]);
  }

  async readManifest(): Promise<readonly ManifestEntry[]> {
    return this.#localManifest?.readManifest() ?? [];
  }
}
