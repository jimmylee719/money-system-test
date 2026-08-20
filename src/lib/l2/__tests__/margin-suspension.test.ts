/**
 * P11.15 停資停券否決規則。
 *
 * 【本檔最重要的一組在最後面：「不 fail-closed」】
 * 其餘四條 L2 規則的來源缺漏時會全面否決（fail-closed）。
 * 這一條刻意不是 —— 停資停券擋的是融資融券，而 CLAUDE.md 明文禁止本系統
 * 使用融資融券，所以它不影響我們的執行能力。
 * 讓一個我們根本不用的市場機制握有「整天停機」的權力是錯的。
 *
 * 這個取捨若日後被誰「順手改成跟其他規則一致」，測試會失敗，
 * 並且會先讀到這段說明。
 */

import { describe, expect, it } from 'vitest';

import { buildVetoContext } from '../context';
import { applyVetoes } from '../engine';
import type { SourceAvailability } from '../engine';
import { normalizeTwseMarginSuspension } from '../normalize';
import { RULE_SPEC_BY_ID, checkMarginSuspension } from '../rules';
import type { MarginSuspensionRow } from '../types';

const DAY = '2026-08-19';
const ALL_AVAILABLE: SourceAvailability = {
  attention: true,
  disposition: true,
  suspension: true,
  alteredTrading: true,
};

function row(
  code: string,
  start: string | null,
  end: string | null,
  reason = '股價波動過度劇烈',
): MarginSuspensionRow {
  return {
    code,
    market: 'TWSE',
    periodStart: start,
    periodEnd: end,
    periodRaw: `${start ?? '?'}～${end ?? '?'}`,
    reason,
  };
}

function ctx(rows: readonly MarginSuspensionRow[] = []) {
  return buildVetoContext({
    signalDate: DAY,
    attention: [],
    disposition: [],
    suspension: [],
    alteredTrading: [],
    marginSuspension: rows,
  });
}

describe('normalizeTwseMarginSuspension — BFI84U 實測形狀', () => {
  it('民國壓縮日期轉 ISO，原文逐字保留', () => {
    // 2026-08-20 實測的欄位與格式
    const out = normalizeTwseMarginSuspension([
      {
        Code: '1234',
        Name: '測試公司',
        StartDate: '1150817',
        EndDate: '1150820',
        Reason: '股價波動過度劇烈',
      },
    ]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      code: '1234',
      market: 'TWSE',
      periodStart: '2026-08-17',
      periodEnd: '2026-08-20',
      periodRaw: '1150817～1150820',
      reason: '股價波動過度劇烈',
    });
  });

  it('沒有代號的列算佔位列，不當成一筆停券', () => {
    const out = normalizeTwseMarginSuspension([
      { Code: '', Name: '', StartDate: '', EndDate: '', Reason: '' },
    ]);
    expect(out.rows).toHaveLength(0);
  });

  it('日期解析不了時記為 null，不猜也不丟掉這一列', () => {
    const out = normalizeTwseMarginSuspension([
      { Code: '1234', Name: 'x', StartDate: 'N/A', EndDate: '', Reason: 'r' },
    ]);
    expect(out.rows[0]?.periodStart).toBeNull();
    expect(out.rows[0]?.periodEnd).toBeNull();
    expect(out.rows[0]?.periodRaw).toBe('N/A～');
  });

  it('不是陣列時回空，不拋錯', () => {
    expect(normalizeTwseMarginSuspension(null).rows).toHaveLength(0);
    expect(normalizeTwseMarginSuspension({ foo: 1 }).rows).toHaveLength(0);
  });
});

describe('checkMarginSuspension', () => {
  it('停券期間涵蓋訊號日 → 否決，並附官方原文', () => {
    const d = checkMarginSuspension('1234', ctx([row('1234', '2026-08-17', '2026-08-20')]));
    expect(d?.ruleId).toBe('margin_suspension');
    expect(d?.reason).toContain('2026-08-17 ~ 2026-08-20');
    expect(d?.evidence).toContain('股價波動過度劇烈');
  });

  it('期間邊界含端點：起日與迄日當天都算停券中', () => {
    expect(checkMarginSuspension('1234', ctx([row('1234', DAY, '2026-08-25')]))).not.toBeNull();
    expect(checkMarginSuspension('1234', ctx([row('1234', '2026-08-10', DAY)]))).not.toBeNull();
  });

  it('期間已結束或尚未開始 → 放行', () => {
    expect(checkMarginSuspension('1234', ctx([row('1234', '2026-08-10', '2026-08-18')]))).toBeNull();
    expect(checkMarginSuspension('1234', ctx([row('1234', '2026-08-20', '2026-08-25')]))).toBeNull();
  });

  it('清單裡沒有這一檔 → 放行', () => {
    expect(checkMarginSuspension('9999', ctx([row('1234', '2026-08-17', '2026-08-20')]))).toBeNull();
  });

  it('同一檔多筆公告，任一筆涵蓋訊號日就否決', () => {
    const rows = [row('1234', '2026-07-01', '2026-07-10'), row('1234', '2026-08-17', '2026-08-20')];
    expect(checkMarginSuspension('1234', ctx(rows))).not.toBeNull();
  });

  /**
   * 期間解析失敗只影響清單上真的有的那一檔，不會造成全面停機，
   * 故此處採保守作法否決 —— 符合「只減不增」。
   */
  it('期間解析失敗 → 否決，且說明是解析失敗而非確定停券中', () => {
    const d = checkMarginSuspension('1234', ctx([row('1234', null, null)]));
    expect(d?.ruleId).toBe('margin_suspension');
    expect(d?.reason).toContain('無法解析');
    expect(d?.reason).not.toContain('涵蓋訊號日');
  });
});

describe('接進引擎後仍然只減不增', () => {
  it('被停券的擋下，其餘照常通過', () => {
    const result = applyVetoes(
      [{ code: '1111' }, { code: '2222' }],
      ctx([row('1111', '2026-08-17', '2026-08-20')]),
      ALL_AVAILABLE,
    );
    expect(result.passed.map((c) => c.code)).toEqual(['2222']);
    expect(result.vetoed.map((v) => v.ruleId)).toEqual(['margin_suspension']);
    expect(result.countsByRule['margin_suspension']).toBe(1);
  });

  it('規則有登記自我說明，且誠實標為 suspected 而非 certain', () => {
    const spec = RULE_SPEC_BY_ID.get('margin_suspension');
    expect(spec).toBeDefined();
    expect(spec?.confidence).toBe('suspected');
    expect(spec?.rationale).toContain('不 fail-closed');
  });
});

/**
 * ⚠️ 以下三則是本檔的核心。改動前請先讀本檔開頭的說明。
 */
describe('這一條刻意不 fail-closed', () => {
  it('完全不提供停券資料時，不會全面否決', () => {
    const result = applyVetoes([{ code: '1111' }, { code: '2222' }], ctx(), ALL_AVAILABLE);
    expect(result.failedClosed).toBe(false);
    expect(result.passed).toHaveLength(2);
  });

  it('buildVetoContext 可以完全省略 marginSuspension —— 其餘四個不行', () => {
    const c = buildVetoContext({
      signalDate: DAY,
      attention: [],
      disposition: [],
      suspension: [],
      alteredTrading: [],
      // 刻意不傳 marginSuspension
    });
    expect(c.marginSuspension.size).toBe(0);
    expect(checkMarginSuspension('1234', c)).toBeNull();
  });

  it('SourceAvailability 沒有 marginSuspension 這個欄位 —— 它不參與 fail-closed 判定', () => {
    // 型別上就不該有。這一則用執行期斷言把設計意圖釘住：
    // 若日後有人把它加進 availability，missingSources 會多列一項，這裡會失敗。
    const keys = Object.keys(ALL_AVAILABLE).sort();
    expect(keys).toEqual(['alteredTrading', 'attention', 'disposition', 'suspension']);
  });
});
