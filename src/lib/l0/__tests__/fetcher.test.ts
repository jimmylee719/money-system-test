import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FETCH_OPTIONS, fetchSource } from '../fetcher';
import { TWSE_STOCK_DAY_ALL } from '../sources';
import type { L0Deps } from '../types';

const BODY = JSON.stringify([{ Date: '1150814', Code: '1101' }]);

/** 每次呼叫 now() 前進 100ms，讓 durationMs 可預測 */
function makeDeps(fetchImpl: L0Deps['fetchImpl']): {
  deps: L0Deps;
  sleepCalls: number[];
} {
  let tick = 0;
  const sleepCalls: number[] = [];
  return {
    sleepCalls,
    deps: {
      fetchImpl,
      now: () => {
        const d = new Date(Date.UTC(2026, 7, 16, 0, 0, 0, 0) + tick * 100);
        tick += 1;
        return d;
      },
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    },
  };
}

describe('fetchSource', () => {
  it('returns a snapshot on the first successful attempt', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(BODY, {
        status: 200,
        headers: { etag: 'W/"abc"', 'last-modified': 'Sat, 15 Aug 2026 21:20:55 GMT' },
      }),
    );
    const { deps, sleepCalls } = makeDeps(fetchImpl as unknown as L0Deps['fetchImpl']);

    const result = await fetchSource(TWSE_STOCK_DAY_ALL, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.attempt).toBe(1);
    expect(result.snapshot.httpStatus).toBe(200);
    expect(result.snapshot.durationMs).toBe(100);
    expect(result.snapshot.etag).toBe('W/"abc"');
    expect(result.snapshot.dataAsOf).toBe('2026-08-14');
    expect(Buffer.from(result.body).toString('utf8')).toBe(BODY);
    expect(sleepCalls).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the response bytes verbatim (no re-serialisation)', async () => {
    // 刻意用不規則空白與官方錯字欄位，證明我們不重新格式化
    const weird = '[ {"Date":"1150814",  "LatesAskPrice":"45.06"} ]';
    const fetchImpl = vi.fn(async () => new Response(weird, { status: 200 }));
    const { deps } = makeDeps(fetchImpl as unknown as L0Deps['fetchImpl']);

    const result = await fetchSource(TWSE_STOCK_DAY_ALL, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.body).toString('utf8')).toBe(weird);
    expect(result.snapshot.observedFields).toEqual(['Date', 'LatesAskPrice']);
  });

  it('retries on HTTP 500 then succeeds, recording the attempt number', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call < 3 ? new Response('boom', { status: 500 }) : new Response(BODY, { status: 200 });
    });
    const { deps, sleepCalls } = makeDeps(fetchImpl as unknown as L0Deps['fetchImpl']);

    const result = await fetchSource(TWSE_STOCK_DAY_ALL, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.attempt).toBe(3);
    // 退避延遲：第 1 次失敗後 1000ms，第 2 次失敗後 2000ms
    expect(sleepCalls).toEqual([1000, 2000]);
  });

  it('retries on a thrown network error and gives up after maxAttempts', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { deps, sleepCalls } = makeDeps(fetchImpl as unknown as L0Deps['fetchImpl']);

    const result = await fetchSource(TWSE_STOCK_DAY_ALL, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(DEFAULT_FETCH_OPTIONS.maxAttempts);
    expect(result.error).toContain('TypeError: fetch failed');
    expect(result.error).toContain('attempt 3');
    expect(sleepCalls).toEqual([1000, 2000]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('treats any non-2xx as failure — never stores a partial response', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>maintenance</html>', { status: 503 }));
    const { deps } = makeDeps(fetchImpl as unknown as L0Deps['fetchImpl']);

    const result = await fetchSource(TWSE_STOCK_DAY_ALL, deps, {
      timeoutMs: 1000,
      maxAttempts: 2,
      retryBaseDelayMs: 5,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('HTTP 503');
  });
});
