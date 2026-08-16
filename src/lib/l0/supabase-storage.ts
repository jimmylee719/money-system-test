/**
 * Supabase Storage 的原始 bytes 儲存實作。
 *
 * 【壓縮】上傳前以 gzip level 9 壓縮。實測 13 個來源 8.27 MB → 1.09 MB（7.6x），
 * 櫃買行情單檔 4.0 MB → 388 KB（10.3x）。免費 1 GB 可用約 2.6 年。
 *
 * 【物件命名】<source_id>/<data_as_of>/<content_hash>.json.gz
 * 檔名是【原始 bytes】的 SHA-256，不是壓縮後的：
 *   - 內容定址去重仍然成立（同內容 → 同路徑 → 不重複上傳）
 *   - 下載解壓後可直接與帳本的 content_hash 比對，兩層互相稽核
 *   - gzip 不需要具備決定性（其標頭含 OS 位元組），因為雜湊算的是壓縮前的資料
 *
 * 【append-only】上傳一律不帶 x-upsert，物件已存在即回傳 409，
 * 本實作將其視為 written:false 而非錯誤 —— 與 FileSnapshotStore 的 'wx' 語意一致。
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import { sha256Hex } from './snapshot';
import type { BodyStore, BodyStoreKind, PutResult, RawSnapshot } from './types';

export const DEFAULT_BUCKET = 'l0-raw';
export const UNKNOWN_DATE_PREFIX = 'unknown-date';

/** gzip 壓縮等級。9 為最高；資料量小、每日一次，時間成本可忽略。 */
const GZIP_LEVEL = 9;

export class StorageError extends Error {
  readonly status: number;

  constructor(operation: string, status: number, body: string) {
    super(`Supabase Storage ${operation} 回應 ${status}：${body.slice(0, 300)}`);
    this.name = 'StorageError';
    this.status = status;
  }
}

/**
 * 判斷錯誤回應是否為「物件已存在」。
 * 依實測回應格式判斷，不依 HTTP 狀態碼——見 put() 內的說明。
 */
export function isDuplicateError(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as {
      code?: unknown;
      error?: unknown;
      statusCode?: unknown;
    };
    return (
      parsed.code === 'KeyAlreadyExists' ||
      parsed.error === 'Duplicate' ||
      parsed.statusCode === '409'
    );
  } catch {
    return false;
  }
}

export interface SupabaseStorageOptions {
  readonly url: string;
  readonly apiKey: string;
  readonly bucket?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class SupabaseStorageBodyStore implements BodyStore {
  readonly #url: string;
  readonly #apiKey: string;
  readonly #bucket: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: SupabaseStorageOptions) {
    this.#url = options.url.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#bucket = options.bucket ?? DEFAULT_BUCKET;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  get kind(): BodyStoreKind {
    return 'supabase_storage';
  }

  get bucket(): string {
    return this.#bucket;
  }

  objectPathFor(snapshot: RawSnapshot): string {
    return `${snapshot.sourceId}/${snapshot.dataAsOf ?? UNKNOWN_DATE_PREFIX}/${snapshot.contentHash}.json.gz`;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.#apiKey,
      Authorization: `Bearer ${this.#apiKey}`,
      ...extra,
    };
  }

  async put(snapshot: RawSnapshot, body: Uint8Array): Promise<PutResult> {
    const objectPath = this.objectPathFor(snapshot);
    const compressed = gzipSync(body, { level: GZIP_LEVEL });

    const res = await this.#fetch(`${this.#url}/storage/v1/object/${this.#bucket}/${objectPath}`, {
      method: 'POST',
      // 刻意不帶 x-upsert：物件已存在必須失敗，不可覆蓋既有原始資料
      headers: this.#headers({
        'Content-Type': 'application/gzip',
        'Cache-Control': 'max-age=31536000, immutable',
      }),
      body: compressed,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (res.ok) {
      return { bodyPath: objectPath, written: true, storedBytes: compressed.byteLength };
    }

    const errorBody = await res.text();
    // 物件已存在＝同內容重複抓取，內容定址之下這是正常結果而非錯誤。
    //
    // ⚠️ 實測（2026-08-16）：Supabase Storage 回的是 **HTTP 400**，
    //    409 只出現在 body 的 statusCode 欄位：
    //      {"statusCode":"409","error":"Duplicate","message":"The resource already exists",
    //       "code":"KeyAlreadyExists"}
    //    因此不能只看 HTTP 狀態碼。同時保留對真正 HTTP 409 的判斷，
    //    以免日後行為改變又壞掉。
    if (res.status === 409 || isDuplicateError(errorBody)) {
      // 已存在的物件內容相同（內容定址），壓縮後大小也必然相同
      return { bodyPath: objectPath, written: false, storedBytes: compressed.byteLength };
    }
    throw new StorageError(`upload ${objectPath}`, res.status, errorBody);
  }

  /**
   * 查詢物件的實際佔用大小，**不下載內容**。
   * 用於帳本尚無 body_bytes 欄位時的容量統計備援：
   * 一次呼叫只取中繼資料，不消耗 egress 額度（免費方案 5 GB/月）。
   * 物件不存在回傳 null。
   */
  async size(objectPath: string): Promise<number | null> {
    const res = await this.#fetch(
      `${this.#url}/storage/v1/object/info/${this.#bucket}/${objectPath}`,
      {
        method: 'GET',
        headers: this.#headers(),
        signal: AbortSignal.timeout(this.#timeoutMs),
      },
    );
    if (!res.ok) {
      return null;
    }
    try {
      const info = JSON.parse(await res.text()) as { size?: unknown };
      return typeof info.size === 'number' ? info.size : null;
    } catch {
      return null;
    }
  }

  /** 下載並解壓。供來回一致性驗證與日後回溯使用。 */
  async get(objectPath: string): Promise<Uint8Array> {
    const res = await this.#fetch(`${this.#url}/storage/v1/object/${this.#bucket}/${objectPath}`, {
      method: 'GET',
      headers: this.#headers(),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) {
      throw new StorageError(`download ${objectPath}`, res.status, await res.text());
    }
    return new Uint8Array(gunzipSync(Buffer.from(await res.arrayBuffer())));
  }

  /**
   * 下載後解壓、重算 SHA-256，與帳本的 content_hash 比對。
   * 這是儲存層與帳本層互相稽核的核心動作。
   */
  async verify(objectPath: string, expectedContentHash: string): Promise<boolean> {
    return sha256Hex(await this.get(objectPath)) === expectedContentHash;
  }
}
