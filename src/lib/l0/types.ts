/**
 * P1 — L0 資料層型別。
 *
 * L0 鐵則：**只存不判斷**。
 * - 原始回應以「原始 bytes」逐位元組保存，不重新格式化、不改欄位名、不過濾、不修正錯字。
 * - 中繼資料只記錄「觀察到的事實」（欄位有哪些、日期有哪些、幾列），不做任何商業判定。
 * - append-only：內容相同不重寫，任何一次抓取都在 manifest 留下紀錄（含失敗）。
 */

/** 已實測驗證的資料來源代號 */
export type SourceId =
  | 'twse_stock_day_all'
  | 'twse_bwibbu_all'
  | 'tpex_mainboard_daily_close_quotes'
  | 'tpex_mainboard_peratio_analysis';

/**
 * 來源分級（CLAUDE.md 資料來源優先序）
 * - `official_primary`：官方一手，唯一可作訊號依據
 * - `cross_check`：僅供交叉驗證，不得單獨作為訊號依據
 */
export type SourceTier = 'official_primary' | 'cross_check';

export type Market = 'TWSE' | 'TPEx';

export interface SourceDescriptor {
  readonly id: SourceId;
  readonly url: string;
  readonly market: Market;
  readonly sourceTier: SourceTier;
  readonly description: string;
  /** 端點實測驗證日期（每季覆核） */
  readonly verifiedAt: string;
  /** 實測當日觀察到的欄位，作為 P3 schema drift 的比對基準 */
  readonly baselineFields: readonly string[];
  /** payload 中代表「資料日期」的欄位名（民國年格式，如 "1150814"） */
  readonly dateField: string;
}

/** data_as_of 判定結果的原因，永遠記錄，不推測 */
export type DataAsOfReason =
  | 'single_date_in_payload'
  | 'multiple_dates_in_payload'
  | 'date_field_missing'
  | 'date_unparsable'
  | 'payload_not_an_array'
  | 'payload_empty'
  | 'invalid_json';

/** 對 payload 的純觀察結果，不含任何時鐘或網路資訊 */
export interface PayloadInspection {
  /** 自 payload 取得的資料日期（ISO）。無法唯一判定時為 null。 */
  readonly dataAsOf: string | null;
  readonly dataAsOfReason: DataAsOfReason;
  /** payload 出現過的所有原始日期值（民國年字串），最多保留 50 筆 */
  readonly observedDataDates: readonly string[];
  /** 所有列出現過的欄位聯集（排序後）。非陣列時為 null。 */
  readonly observedFields: readonly string[] | null;
  readonly rowCount: number | null;
  /** 欄位組合與第一列不同的列數——非 0 即代表 payload 內部結構不一致 */
  readonly heterogeneousRowCount: number | null;
}

/** 原始快照中繼資料。原始 bytes 另存，不放在這裡。 */
export interface RawSnapshot extends PayloadInspection {
  readonly sourceId: SourceId;
  readonly url: string;
  readonly market: Market;
  readonly sourceTier: SourceTier;
  /** 抓取時間，ISO 8601 UTC。來自注入的時鐘。 */
  readonly fetchedAt: string;
  /** 原始 bytes 的 SHA-256（hex） */
  readonly contentHash: string;
  readonly contentLength: number;
  readonly httpStatus: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly durationMs: number;
  /** 第幾次嘗試成功（1 起算） */
  readonly attempt: number;
}

export type IngestStatus = 'stored' | 'duplicate' | 'failed';

/** manifest.jsonl 的一行。append-only，永不覆寫。 */
export interface ManifestEntry {
  readonly sourceId: SourceId;
  readonly status: IngestStatus;
  readonly fetchedAt: string;
  readonly dataAsOf: string | null;
  readonly contentHash: string | null;
  readonly bodyPath: string | null;
  readonly error: string | null;
  readonly snapshot: RawSnapshot | null;
}

export interface PutResult {
  readonly bodyPath: string;
  /** false 代表內容已存在，未重寫（append-only 語意） */
  readonly written: boolean;
}

/** 儲存埠。P1 為本機檔案實作；P3 換成 Supabase 時只換這個實作。 */
export interface SnapshotStore {
  put(snapshot: RawSnapshot, body: Uint8Array): Promise<PutResult>;
  appendManifest(entry: ManifestEntry): Promise<void>;
  readManifest(): Promise<readonly ManifestEntry[]>;
}

/** 注入的相依，讓抓取層可測試且不碰真實網路／時鐘 */
export interface L0Deps {
  readonly fetchImpl: typeof fetch;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface FetchOptions {
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly retryBaseDelayMs: number;
}

export type FetchSourceResult =
  | { readonly ok: true; readonly snapshot: RawSnapshot; readonly body: Uint8Array }
  | { readonly ok: false; readonly error: string; readonly attempts: number };

export interface IngestResult {
  readonly sourceId: SourceId;
  readonly status: IngestStatus;
  readonly snapshot: RawSnapshot | null;
  readonly bodyPath: string | null;
  readonly error: string | null;
}
