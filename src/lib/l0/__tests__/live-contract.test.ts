/**
 * 對真實 TWSE / TPEx 端點的契約測試。
 *
 * 預設 **跳過**——單元測試不得依賴外部網路。
 * 手動執行（P1 驗證閘門、以及每季覆核時）：
 *
 *   L0_LIVE=1 npm test          (bash)
 *   $env:L0_LIVE='1'; npm test  (PowerShell)
 *
 * 這支測試驗證的是「註冊表寫的端點與欄位，跟官方現在真的回傳的一致」。
 */

import { describe, expect, it } from 'vitest';
import { fetchSource } from '../fetcher';
import { diffFields } from '../snapshot';
import { ALL_SOURCES } from '../sources';
import type { L0Deps } from '../types';

const LIVE = process.env['L0_LIVE'] === '1';

const liveDeps: L0Deps = {
  fetchImpl: (input, init) => fetch(input, init),
  now: () => new Date(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

describe.skipIf(!LIVE)('live contract — 真實官方端點', () => {
  for (const source of ALL_SOURCES) {
    it(
      `${source.id} 回應 200 且欄位與註冊表一致`,
      async () => {
        const result = await fetchSource(source, liveDeps);
        expect(result.ok, result.ok ? '' : result.error).toBe(true);
        if (!result.ok) return;

        const s = result.snapshot;
        expect(s.httpStatus).toBe(200);
        expect(s.contentLength).toBeGreaterThan(0);
        expect(s.rowCount ?? 0).toBeGreaterThan(0);

        // 欄位無漂移
        const drift = diffFields(source.baselineFields, s.observedFields);
        expect(drift, `schema drift on ${source.id}`).toEqual({ added: [], removed: [] });

        // 每一列的欄位組合一致
        expect(s.heterogeneousRowCount).toBe(0);

        // data_as_of 依來源宣告的規則解析成功
        expect(['single_date_in_payload', 'max_date_in_payload']).toContain(s.dataAsOfReason);
        expect(s.dataAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        // 資料日期不得晚於抓取日期
        expect((s.dataAsOf ?? '').localeCompare(s.fetchedAt.slice(0, 10))).toBeLessThanOrEqual(0);

        // 有宣告 periodField 的來源，data_period 必須解析成功且不晚於 data_as_of
        if (source.periodField !== null) {
          expect(s.dataPeriod).toMatch(/^\d{4}-\d{2}$/);
          expect((s.dataPeriod ?? '').localeCompare((s.dataAsOf ?? '').slice(0, 7))).toBeLessThanOrEqual(0);
        } else {
          expect(s.dataPeriod).toBe(null);
        }
      },
      60_000,
    );
  }
});
