/**
 * HTTP 抓取層。所有 I/O 相依（fetch / 時鐘 / sleep）皆由外部注入，
 * 測試不碰真實網路，也不依賴本機時間。
 *
 * 非 2xx 一律視為失敗並重試——L0 不猜測部分成功的回應該怎麼用。
 *
 * 【HTTP 200 不等於拿到資料】（2026-08-16 事故後補上）
 * 那天 18:57（台北）TWSE 對**全部 11 個**來源回了 HTTP 200，內容卻是一頁
 * 「因為安全性考量，您所執行的頁面無法呈現 / FOR SECURITY REASONS, THIS PAGE
 * CAN NOT BE ACCESSED」。原本的程式只看狀態碼，於是把封鎖頁當成正常快照存起來，
 * 它成為 latest 之後，L1／L2／P11 全部拿到一個 800 bytes 的 HTML。
 *
 * 修法：抓完之後檢查內容是不是當初登記的格式（`payloadShape`）。
 * 這**不是**在解讀資料內容——那會違反「L0 只存不判斷」——
 * 而是確認「我們到底有沒有拿到東西」。兩者的界線是：
 * 前者問「資料說了什麼」，後者問「這是不是我們登記的那個格式」。
 */

import { buildSnapshot, isUnusablePayload, looksLikeHtml } from './snapshot';
import type { FetchOptions, FetchSourceResult, L0Deps, SourceDescriptor } from './types';

/** 錯誤訊息裡附上回應開頭幾個字，讓人一眼看出對方回了什麼 */
const PAYLOAD_PREVIEW_CHARS = 120;

function preview(body: Uint8Array): string {
  return Buffer.from(body.slice(0, PAYLOAD_PREVIEW_CHARS * 3))
    .toString('utf8')
    .replace(/\s+/g, ' ')
    .slice(0, PAYLOAD_PREVIEW_CHARS);
}

export const DEFAULT_FETCH_OPTIONS: FetchOptions = {
  timeoutMs: 30_000,
  maxAttempts: 3,
  retryBaseDelayMs: 1_000,
};

/** 來源之間的禮貌延遲，避免對交易所主機造成壓力 */
export const DEFAULT_POLITENESS_DELAY_MS = 1_000;

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

export async function fetchSource(
  source: SourceDescriptor,
  deps: L0Deps,
  options: FetchOptions = DEFAULT_FETCH_OPTIONS,
  /** 已填入日期參數的實際網址。未提供時使用 source.url。 */
  url: string = source.url,
): Promise<FetchSourceResult> {
  const errors: string[] = [];

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const startedAt = deps.now();
    try {
      const response = await deps.fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMs),
      });

      if (!response.ok) {
        errors.push(`attempt ${attempt}: HTTP ${response.status}`);
      } else {
        const body = new Uint8Array(await response.arrayBuffer());
        const finishedAt = deps.now();
        const snapshot = buildSnapshot({
          source,
          url,
          body,
          fetchedAt: finishedAt,
          httpStatus: response.status,
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          attempt,
        });

        if (isUnusablePayload(snapshot.dataAsOfReason)) {
          errors.push(
            `attempt ${attempt}: HTTP ${response.status} 但內容不是登記的格式` +
              `（${snapshot.dataAsOfReason}，${body.length} bytes）：${preview(body)}`,
          );
          // 對方回 HTML 就別再敲了。錯誤頁不會在兩秒內變成 JSON，
          // 而這種情況通常正是被限流／擋下——重試只會讓封鎖更久。
          if (looksLikeHtml(body)) {
            errors.push('內容為 HTML，判定為端點拒絕服務或錯誤頁，不再重試');
            break;
          }
        } else {
          return { ok: true, body, snapshot };
        }
      }
    } catch (error) {
      errors.push(`attempt ${attempt}: ${describeError(error)}`);
    }

    if (attempt < options.maxAttempts) {
      await deps.sleep(options.retryBaseDelayMs * attempt);
    }
  }

  return {
    ok: false,
    error: errors.join('; '),
    attempts: options.maxAttempts,
  };
}
