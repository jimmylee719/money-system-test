/**
 * 原始 payload 觀察與快照組裝。除了 SHA-256 之外全為純函式。
 *
 * 只記錄「觀察到的事實」：欄位有哪些、日期有哪些、幾列、結構是否一致。
 * 不修正、不過濾、不補值、不判斷資料好壞。
 *
 * 日期怎麼取，是**來源註冊表事先宣告**的規則（`dateField` / `dateFormat` /
 * `dateSelection`），不是看到資料才決定，而且採用哪個規則會寫進 `dataAsOfReason`。
 */

import { createHash } from 'node:crypto';
import { parseSourceDate, parseSourcePeriod } from './date-formats';
import type {
  DataAsOfReason,
  PayloadDateSpec,
  PayloadInspection,
  RawSnapshot,
  SourceDescriptor,
} from './types';

/** payload 中保留的相異日期／期間值上限，避免異常資料撐爆中繼資料 */
const MAX_OBSERVED_VALUES = 50;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(reason: DataAsOfReason): PayloadInspection {
  return {
    dataAsOf: null,
    dataAsOfReason: reason,
    dataPeriod: null,
    observedDataPeriods: [],
    observedDataDates: [],
    observedFields: null,
    rowCount: null,
    heterogeneousRowCount: null,
  };
}

function keySignature(row: Record<string, unknown>): string {
  return Object.keys(row).sort().join(' ');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 「這個回應根本不是我們登記的格式」的兩種理由。
 *
 * 【要分清楚兩件事，混在一起會出人命】
 *   - `date_field_missing` / `date_unparsable`／`payload_empty`
 *     ＝ 拿到的**是**登記的格式，只是這份資料沒有日期。
 *       twse_margin_balance、twse_attention 等來源本來就是這樣（L0 實測），
 *       L2 用「同一次抓取」規則處理它們。這些是正常資料，不可排除。
 *   - `invalid_json` / `payload_not_an_array`
 *     ＝ 拿到的**根本不是** JSON 陣列。端點回了 HTML、錯誤頁、封鎖頁之類的東西。
 *       這不是「這份資料沒有日期」，是「我們沒有拿到資料」。
 *
 * 2026-08-16 實測：TWSE 對全部 11 個來源回了 HTTP **200** 加一頁
 * 「因為安全性考量，您所執行的頁面無法呈現」。狀態碼是 200，所以抓取層照收，
 * 存成快照後成為 latest，下游整條垮掉。判斷「有沒有拿到東西」不是解讀資料，
 * 是確認我們拿到的是不是當初登記的那個格式——這不違反「L0 只存不判斷」。
 */
export const UNUSABLE_PAYLOAD_REASONS: readonly DataAsOfReason[] = [
  'invalid_json',
  'payload_not_an_array',
];

/** 這個 payload 是不是「根本沒拿到資料」 */
export function isUnusablePayload(reason: DataAsOfReason): boolean {
  return UNUSABLE_PAYLOAD_REASONS.includes(reason);
}

/** 回應看起來是不是 HTML（錯誤頁／封鎖頁通常長這樣） */
export function looksLikeHtml(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.slice(0, 64)).toString('utf8').trimStart().startsWith('<');
}

/**
 * 檢視原始 bytes，抽出可觀察的中繼資料。
 * 解析失敗不拋錯——把失敗原因記錄下來，原始 bytes 照存。
 */
/**
 * TWSE 網站端點形狀：`{stat, date, fields: string[], data: string[][]}`。
 * 欄位名與資料分離，日期在頂層而非每一列。
 * 一樣只記錄觀察到的事實：欄位就是 `fields` 逐字照抄，不改名不清洗。
 */
function inspectRwdTable(parsed: unknown, spec: PayloadDateSpec): PayloadInspection {
  if (!isPlainObject(parsed)) {
    return fail('payload_not_an_array');
  }
  const fields = parsed['fields'];
  const data = parsed['data'];
  if (!Array.isArray(fields) || !Array.isArray(data)) {
    // stat 非 OK（例如非交易日）時官方不會給 fields/data，如實記為空
    return {
      dataAsOf: null,
      dataAsOfReason: 'payload_empty',
      dataPeriod: null,
      observedDataPeriods: [],
      observedDataDates: [],
      observedFields: [],
      rowCount: 0,
      heterogeneousRowCount: 0,
    };
  }

  const observedFields = fields.filter((f): f is string => typeof f === 'string');
  // 欄數與 fields 不符的列＝結構不一致，記錄但不修正
  const heterogeneousRowCount = data.filter(
    (row) => !Array.isArray(row) || row.length !== fields.length,
  ).length;

  const rawDate = parsed[spec.dateField];
  const base = {
    dataPeriod: null,
    observedDataPeriods: [],
    observedDataDates: typeof rawDate === 'string' ? [rawDate] : [],
    observedFields: [...observedFields].sort(),
    rowCount: data.length,
    heterogeneousRowCount,
  } as const;

  if (typeof rawDate !== 'string') {
    return { ...base, dataAsOf: null, dataAsOfReason: 'date_field_missing' };
  }
  const iso = parseSourceDate(rawDate, spec.dateFormat);
  if (iso === null) {
    return { ...base, dataAsOf: null, dataAsOfReason: 'date_unparsable' };
  }
  return { ...base, dataAsOf: iso, dataAsOfReason: 'single_date_in_payload' };
}

export function inspectPayload(bytes: Uint8Array, spec: PayloadDateSpec): PayloadInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return fail('invalid_json');
  }

  if (spec.payloadShape === 'twse_rwd_table') {
    return inspectRwdTable(parsed, spec);
  }

  if (!Array.isArray(parsed)) {
    return fail('payload_not_an_array');
  }
  if (parsed.length === 0) {
    return {
      dataAsOf: null,
      dataAsOfReason: 'payload_empty',
      dataPeriod: null,
      observedDataPeriods: [],
      observedDataDates: [],
      observedFields: [],
      rowCount: 0,
      heterogeneousRowCount: 0,
    };
  }

  const fieldUnion = new Set<string>();
  const rawDates = new Set<string>();
  const rawPeriods = new Set<string>();
  let firstSignature: string | null = null;
  let heterogeneousRowCount = 0;
  let sawDateField = false;
  // 與 rawDates 的 50 筆上限脫鉤，確保 'max' 規則在超過上限時仍正確
  let maxIsoDate: string | null = null;
  let maxIsoPeriod: string | null = null;

  for (const row of parsed) {
    if (!isPlainObject(row)) {
      heterogeneousRowCount += 1;
      continue;
    }
    for (const key of Object.keys(row)) {
      fieldUnion.add(key);
    }
    const signature = keySignature(row);
    if (firstSignature === null) {
      firstSignature = signature;
    } else if (signature !== firstSignature) {
      heterogeneousRowCount += 1;
    }

    const rawDate = row[spec.dateField];
    if (typeof rawDate === 'string') {
      sawDateField = true;
      if (rawDates.size < MAX_OBSERVED_VALUES) {
        rawDates.add(rawDate);
      }
      const iso = parseSourceDate(rawDate, spec.dateFormat);
      if (iso !== null && (maxIsoDate === null || iso > maxIsoDate)) {
        maxIsoDate = iso;
      }
    }

    if (spec.periodField !== null && spec.periodFormat !== null) {
      const rawPeriod = row[spec.periodField];
      if (typeof rawPeriod === 'string') {
        if (rawPeriods.size < MAX_OBSERVED_VALUES) {
          rawPeriods.add(rawPeriod);
        }
        const period = parseSourcePeriod(rawPeriod, spec.periodFormat);
        if (period !== null && (maxIsoPeriod === null || period > maxIsoPeriod)) {
          maxIsoPeriod = period;
        }
      }
    }
  }

  const base = {
    dataPeriod: maxIsoPeriod,
    observedDataPeriods: [...rawPeriods],
    observedDataDates: [...rawDates],
    observedFields: [...fieldUnion].sort(),
    rowCount: parsed.length,
    heterogeneousRowCount,
  } as const;

  if (!sawDateField) {
    return { ...base, dataAsOf: null, dataAsOfReason: 'date_field_missing' };
  }
  if (maxIsoDate === null) {
    return { ...base, dataAsOf: null, dataAsOfReason: 'date_unparsable' };
  }
  if (spec.dateSelection === 'max') {
    return { ...base, dataAsOf: maxIsoDate, dataAsOfReason: 'max_date_in_payload' };
  }
  if (base.observedDataDates.length > 1) {
    return { ...base, dataAsOf: null, dataAsOfReason: 'multiple_dates_in_payload' };
  }
  return { ...base, dataAsOf: maxIsoDate, dataAsOfReason: 'single_date_in_payload' };
}

export interface BuildSnapshotArgs {
  readonly source: SourceDescriptor;
  /** 實際抓取的網址（含已填入的日期參數），可能與 source.url 樣板不同 */
  readonly url?: string;
  readonly body: Uint8Array;
  readonly fetchedAt: Date;
  readonly httpStatus: number;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly durationMs: number;
  readonly attempt: number;
}

export function buildSnapshot(args: BuildSnapshotArgs): RawSnapshot {
  const inspection = inspectPayload(args.body, args.source);
  return {
    ...inspection,
    sourceId: args.source.id,
    url: args.url ?? args.source.url,
    market: args.source.market,
    sourceTier: args.source.sourceTier,
    fetchedAt: args.fetchedAt.toISOString(),
    contentHash: sha256Hex(args.body),
    contentLength: args.body.byteLength,
    httpStatus: args.httpStatus,
    etag: args.etag,
    lastModified: args.lastModified,
    durationMs: args.durationMs,
    attempt: args.attempt,
  };
}

/**
 * 與註冊表基準欄位的差異。**集合式比對，與順序無關**
 * （基準欄位照 API 回傳順序記錄，觀察欄位則已排序）。
 * P1/P2 只計算不阻擋；drift 落地與告警是 P3。
 */
export function diffFields(
  baseline: readonly string[],
  observed: readonly string[] | null,
): { readonly added: readonly string[]; readonly removed: readonly string[] } {
  if (observed === null) {
    return { added: [], removed: [...baseline] };
  }
  const baseSet = new Set(baseline);
  const obsSet = new Set(observed);
  return {
    added: observed.filter((f) => !baseSet.has(f)),
    removed: baseline.filter((f) => !obsSet.has(f)),
  };
}
