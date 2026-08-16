/**
 * HTTP 抓取層。所有 I/O 相依（fetch / 時鐘 / sleep）皆由外部注入，
 * 測試不碰真實網路，也不依賴本機時間。
 *
 * 非 2xx 一律視為失敗並重試——L0 不猜測部分成功的回應該怎麼用。
 */

import { buildSnapshot } from './snapshot';
import type { FetchOptions, FetchSourceResult, L0Deps, SourceDescriptor } from './types';

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
        return {
          ok: true,
          body,
          snapshot: buildSnapshot({
            source,
            url,
            body,
            fetchedAt: finishedAt,
            httpStatus: response.status,
            etag: response.headers.get('etag'),
            lastModified: response.headers.get('last-modified'),
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            attempt,
          }),
        };
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
