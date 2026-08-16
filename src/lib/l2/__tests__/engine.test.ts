import { describe, expect, it } from 'vitest';
import { buildVetoContext } from '../context';
import {
  VetoLayerViolationError,
  applyVetoes,
  assertOnlySubtracts,
  missingSources,
} from '../engine';
import type { SourceAvailability } from '../engine';
import type { AlteredTradingRow, AttentionRow, DispositionRow, SuspensionRow } from '../types';

const DAY = '2026-08-14';
const ALL_AVAILABLE: SourceAvailability = {
  attention: true,
  disposition: true,
  suspension: true,
  alteredTrading: true,
};

function candidates(...codes: string[]): readonly { code: string }[] {
  return codes.map((code) => ({ code }));
}

function ctx(over: {
  attention?: readonly AttentionRow[];
  disposition?: readonly DispositionRow[];
  suspension?: readonly SuspensionRow[];
  alteredTrading?: readonly AlteredTradingRow[];
} = {}) {
  return buildVetoContext({
    signalDate: DAY,
    attention: over.attention ?? [],
    disposition: over.disposition ?? [],
    suspension: over.suspension ?? [],
    alteredTrading: over.alteredTrading ?? [],
  });
}

function disposition(code: string, start: string | null, end: string | null): DispositionRow {
  return {
    code,
    market: 'TWSE',
    announcedDate: '2026-08-11',
    periodStart: start,
    periodEnd: end,
    periodRaw: `${start}~${end}`,
    reason: '連續三次',
    measure: '第二次處置',
  };
}

// ── 只能否決，這是鐵則 ───────────────────────────────────────────────────────

describe('L2 只能否決（CLAUDE.md 鐵則四）', () => {
  it('沒有任何限制時全部通過，且回傳的就是原本那些物件', () => {
    const input = candidates('1101', '1102', '1103');
    const result = applyVetoes(input, ctx(), ALL_AVAILABLE);
    expect(result.passed).toHaveLength(3);
    // 必須是同一批物件，不是複製品 —— 複製品代表中間可能被改過
    expect(result.passed[0]).toBe(input[0]);
    expect(result.vetoed).toHaveLength(0);
  });

  it('通過數永遠不超過輸入數', () => {
    const input = candidates('1101', '1102');
    const result = applyVetoes(input, ctx({ attention: [attention('1101')] }), ALL_AVAILABLE);
    expect(result.passed.length).toBeLessThanOrEqual(input.length);
  });

  it('通過 + 被否決的相異代號 = 輸入，沒有標的憑空消失或出現', () => {
    const input = candidates('1101', '1102', '1103', '1104');
    const result = applyVetoes(
      input,
      ctx({
        attention: [attention('1101')],
        suspension: [suspension('1102', '2026-08-13', null)],
      }),
      ALL_AVAILABLE,
    );
    const vetoedCodes = new Set(result.vetoed.map((v) => v.code));
    expect(result.passed.length + vetoedCodes.size).toBe(input.length);
  });

  it('結構檢查是執行期就會跑的：否決層若產生新標的，直接拋錯', () => {
    const input = candidates('1101');
    expect(() =>
      assertOnlySubtracts(input, {
        passed: [{ code: '9999' }], // 不在輸入裡的新標的
        vetoed: [],
        countsByRule: {},
        failedClosed: false,
      }),
    ).toThrow(VetoLayerViolationError);
  });

  it('結構檢查也擋得住「通過數對不上」與「重複出現」', () => {
    const input = candidates('1101', '1102');
    // 少算了一檔：1102 既沒通過也沒被否決
    expect(() =>
      assertOnlySubtracts(input, {
        passed: [input[0]!],
        vetoed: [],
        countsByRule: {},
        failedClosed: false,
      }),
    ).toThrow(/憑空消失或出現/);

    expect(() =>
      assertOnlySubtracts(input, {
        passed: [input[0]!, input[0]!],
        vetoed: [],
        countsByRule: {},
        failedClosed: false,
      }),
    ).toThrow(/重複出現/);
  });
});

// ── 個別規則 ─────────────────────────────────────────────────────────────────

function attention(code: string): AttentionRow {
  return { code, market: 'TWSE', date: DAY, info: '當日週轉率達23.17%(第四款)' };
}

function suspension(
  code: string,
  haltDate: string | null,
  resumptionDate: string | null,
): SuspensionRow {
  return { code, market: 'TWSE', haltDate, resumptionDate, raw: `暫停 ${haltDate}／恢復 ${resumptionDate}` };
}

describe('處置股：看期間，不看公告日', () => {
  it('處置期間涵蓋訊號日 → 否決', () => {
    const result = applyVetoes(
      candidates('2491'),
      ctx({ disposition: [disposition('2491', '2026-08-12', '2026-08-18')] }),
      ALL_AVAILABLE,
    );
    expect(result.passed).toHaveLength(0);
    expect(result.vetoed[0]!.ruleId).toBe('disposition');
    expect(result.vetoed[0]!.reason).toContain('2026-08-12');
  });

  it('處置期間已結束 → 放行（不能只看有沒有公告）', () => {
    const result = applyVetoes(
      candidates('2491'),
      ctx({ disposition: [disposition('2491', '2026-08-01', '2026-08-07')] }),
      ALL_AVAILABLE,
    );
    expect(result.passed).toHaveLength(1);
  });

  it('處置期間尚未開始 → 放行', () => {
    const result = applyVetoes(
      candidates('5475'),
      ctx({ disposition: [disposition('5475', '2026-08-17', '2026-08-21')] }),
      ALL_AVAILABLE,
    );
    expect(result.passed).toHaveLength(1);
  });

  it('同一檔多筆處置公告，只要有一筆涵蓋訊號日就否決', () => {
    const result = applyVetoes(
      candidates('2491'),
      ctx({
        disposition: [
          disposition('2491', '2026-08-01', '2026-08-07'), // 已結束
          disposition('2491', '2026-08-13', '2026-08-19'), // 進行中
        ],
      }),
      ALL_AVAILABLE,
    );
    expect(result.passed).toHaveLength(0);
  });

  it('期間無法解析 → 否決而非放行（fail-closed）', () => {
    const result = applyVetoes(
      candidates('2491'),
      ctx({ disposition: [disposition('2491', null, null)] }),
      ALL_AVAILABLE,
    );
    expect(result.passed).toHaveLength(0);
    expect(result.vetoed[0]!.reason).toContain('無法確認');
  });
});

describe('暫停交易', () => {
  it('尚未公布恢復日 → 否決', () => {
    const result = applyVetoes(
      candidates('1218'),
      ctx({ suspension: [suspension('1218', '2026-08-13', null)] }),
      ALL_AVAILABLE,
    );
    expect(result.passed).toHaveLength(0);
  });

  it('恢復日在訊號日當天或之前 → 放行', () => {
    // 實測資料：1218 泰山 8/13 暫停、8/14 恢復。訊號日 8/14 應該放行。
    const result = applyVetoes(
      candidates('1218'),
      ctx({ suspension: [suspension('1218', '2026-08-13', '2026-08-14')] }),
      ALL_AVAILABLE,
    );
    expect(result.passed).toHaveLength(1);
  });

  it('恢復日在訊號日之後 → 否決', () => {
    const result = applyVetoes(
      candidates('1218'),
      ctx({ suspension: [suspension('1218', '2026-08-13', '2026-08-20')] }),
      ALL_AVAILABLE,
    );
    expect(result.passed).toHaveLength(0);
  });
});

describe('變更交易方法', () => {
  function altered(code: string, flags: Partial<AlteredTradingRow>): AlteredTradingRow {
    return {
      code,
      market: 'TPEx',
      date: DAY,
      alteredTrading: false,
      periodicTrading: false,
      managedStock: false,
      suspensionOfTrading: false,
      raw: 'raw',
      ...flags,
    };
  }

  it('任一旗標成立即否決，理由列出所有成立的旗標', () => {
    const result = applyVetoes(
      candidates('3064'),
      ctx({ alteredTrading: [altered('3064', { alteredTrading: true, managedStock: true })] }),
      ALL_AVAILABLE,
    );
    expect(result.passed).toHaveLength(0);
    expect(result.vetoed[0]!.reason).toBe('變更交易方法、管理股票');
  });

  it('旗標全空的列不否決（上櫃的表會列出這種列）', () => {
    const result = applyVetoes(
      candidates('3064'),
      ctx({ alteredTrading: [altered('3064', {})] }),
      ALL_AVAILABLE,
    );
    expect(result.passed).toHaveLength(1);
  });
});

describe('多條規則同時命中', () => {
  it('同一檔的每一條都記錄，不只記第一條', () => {
    const result = applyVetoes(
      candidates('2491'),
      ctx({
        attention: [attention('2491')],
        disposition: [disposition('2491', '2026-08-12', '2026-08-18')],
      }),
      ALL_AVAILABLE,
    );
    expect(result.passed).toHaveLength(0);
    expect(result.vetoed).toHaveLength(2);
    expect(result.vetoed.map((v) => v.ruleId).sort()).toEqual(['attention', 'disposition']);
    expect(result.countsByRule['attention']).toBe(1);
    expect(result.countsByRule['disposition']).toBe(1);
  });
});

// ── fail-closed ──────────────────────────────────────────────────────────────

describe('fail-closed：查不到就否決', () => {
  it('任一必要來源缺漏 → 全部否決並標記 failedClosed', () => {
    const input = candidates('1101', '1102', '1103');
    const result = applyVetoes(input, ctx(), { ...ALL_AVAILABLE, disposition: false });
    expect(result.passed).toHaveLength(0);
    expect(result.failedClosed).toBe(true);
    expect(result.vetoed).toHaveLength(3);
    expect(result.vetoed[0]!.ruleId).toBe('source_unavailable');
    expect(result.vetoed[0]!.reason).toContain('處置股');
  });

  it('全部齊備時 failedClosed 為 false —— 0 檔通過與資料壞掉是兩回事', () => {
    const result = applyVetoes(
      candidates('2491'),
      ctx({ disposition: [disposition('2491', '2026-08-12', '2026-08-18')] }),
      ALL_AVAILABLE,
    );
    expect(result.passed).toHaveLength(0);
    expect(result.failedClosed).toBe(false);
  });

  it('missingSources 列出所有缺漏的來源名稱', () => {
    expect(missingSources({ ...ALL_AVAILABLE, attention: false, suspension: false })).toEqual([
      '注意股',
      '暫停交易',
    ]);
  });
});
