/**
 * LINE 日報文字組裝的測試。
 *
 * 【為什麼這份輸出需要測試】
 * 日報是這個系統唯一每天主動送到人眼前的東西，而且帶有法遵義務：
 *   - 歐盟 AI Act 第 50 條與台灣 AI 基本法：須揭露內容由 AI 產生
 *   - CLAUDE.md：觀察榜每次都要重申「不是買進建議」
 * 這些句子一旦在改版時被誰順手刪掉，不會有任何程式報錯，
 * 但每天都會有一則少了法定揭露的訊息送出去。所以要用測試釘住。
 *
 * 這份測試是 2026-08-19 補的 —— 在那之前 buildDailyReport 完全沒有覆蓋。
 */

import { describe, expect, it } from 'vitest';

import type { RankedStock, RankingResult } from '../../l1/factors/engine';
import type { RiskResult } from '../../l3/engine';
import type { VetoDecision, VetoResult } from '../../l2/types';
import { buildDailyReport } from '../line/report';
import type { DailyReportInput } from '../line/report';

function stock(code: string, name: string, score: number): RankedStock {
  return {
    code,
    market: 'TWSE',
    name,
    close: 100,
    compositeScore: score,
    realFactorCount: 4,
    factorScores: [],
  };
}

function decision(code: string, ruleId: VetoDecision['ruleId']): VetoDecision {
  return { code, ruleId, reason: '測試用', evidence: '官方原文' };
}

const RANKING: RankingResult = {
  dataAsOf: '2026-08-18',
  engineVersion: 'test',
  activeFactors: ['a', 'b', 'c', 'd'],
  inactiveFactors: [{ factorKey: 'short_term_reversal_5d_v1', reason: '交易日不足' }],
  universeSize: 2000,
  tradableCount: 1960,
  rankedCount: 1950,
  excludedNoFactorData: 10,
  coverage: {},
  ranked: [],
};

const NO_RISK: RiskResult = {
  approved: [],
  rejected: [],
  countsByReason: {},
  haltedGlobally: false,
  haltReason: null,
};

function build(overrides: Partial<DailyReportInput> = {}): string {
  const watchlist = overrides.watchlist ?? [stock('2542', '興富發', 0.97)];
  const veto: VetoResult<RankedStock> = overrides.veto ?? {
    passed: watchlist,
    vetoed: [],
    countsByRule: {},
    failedClosed: false,
  };
  return buildDailyReport({
    dataAsOf: '2026-08-18',
    ranking: RANKING,
    watchlist,
    veto,
    risk: NO_RISK,
    historyDays: 3,
    volMinObservations: 21,
    entriesThisMonth: 0,
    monthlyEntryCap: 8,
    ...overrides,
  });
}

describe('法遵句子不得因改版而消失', () => {
  it('每一則都附上 AI 產生揭露', () => {
    const text = build();
    expect(text).toContain('本報告由 AI 系統自動產生');
    expect(text).toContain('歐盟 AI Act 第 50 條');
    expect(text).toContain('台灣 AI 基本法');
  });

  it('每一則都聲明不構成投資建議、且 v1 不下單', () => {
    const text = build();
    expect(text).toContain('不構成投資建議');
    expect(text).toContain('v1 不具備下單功能');
  });

  it('觀察榜每次都重申不是買進建議', () => {
    expect(build()).toContain('研究紀錄，不是買進建議');
  });

  it('觀察榜空的時候，那句聲明仍然在', () => {
    const text = build({ watchlist: [] });
    expect(text).toContain('研究紀錄，不是買進建議');
    expect(text).toContain('本報告由 AI 系統自動產生');
  });
});

describe('資料日一定要出現在最上面', () => {
  it('標題帶 data_as_of，而不是系統當天日期', () => {
    expect(build().split('\n')[0]).toContain('2026-08-18');
  });
});

/**
 * 2026-08-19 使用者實際反映：
 * Dashboard 上觀察榜第 2 名標著「擋下」，LINE 版本沒有標，
 * 只看手機的人不會知道那一檔是注意股或處置股。
 */
describe('觀察榜要標示哪幾檔已被 L2 擋下', () => {
  const watchlist = [stock('2542', '興富發', 0.97), stock('6213', '聯茂', 0.91)];
  const veto: VetoResult<RankedStock> = {
    passed: [watchlist[0]!],
    vetoed: [decision('6213', 'attention')],
    countsByRule: { attention: 1 },
    failedClosed: false,
  };

  it('被擋下的那一檔會標示，且寫出是哪一條規則', () => {
    const text = build({ watchlist, veto });
    expect(text).toContain('已被 L2 擋下：注意');
  });

  it('沒被擋的不會被標示', () => {
    const lines = build({ watchlist, veto }).split('\n');
    const idx = lines.findIndex((l) => l.includes('2542'));
    expect(lines[idx + 1]).not.toContain('已被 L2 擋下');
  });

  it('同一檔踩到多條規則時全部列出', () => {
    const text = build({
      watchlist,
      veto: {
        passed: [watchlist[0]!],
        vetoed: [decision('6213', 'attention'), decision('6213', 'disposition')],
        countsByRule: { attention: 1, disposition: 1 },
        failedClosed: false,
      },
    });
    expect(text).toContain('已被 L2 擋下：注意、處置');
  });

  it('標示 L2 狀態不會把被擋的那一檔從觀察榜移除 —— 它是對照組', () => {
    const text = build({ watchlist, veto });
    expect(text).toContain('6213');
    expect(text).toContain('2. 6213');
  });
});

/**
 * 2026-08-18 的實際數字：擋下 51 檔，但處置13＋注意17＋變更23＝53。
 * 兩個數字都對（一個算檔數、一個算規則觸發次數），
 * 但擺在一起看起來像算錯，所以差額要明講。
 */
describe('擋下檔數與規則次數對不起來時要說明', () => {
  it('有檔踩到多條時，寫出有幾檔踩多條', () => {
    const text = build({
      veto: {
        passed: [],
        vetoed: [
          decision('1111', 'attention'),
          decision('1111', 'disposition'),
          decision('2222', 'attention'),
        ],
        countsByRule: { attention: 2, disposition: 1 },
        failedClosed: false,
      },
    });
    expect(text).toContain('L2 擋下 2 檔');
    expect(text).toContain('其中 1 檔踩到多條');
  });

  it('一檔踩三條時算 1 檔，不是 2 檔 —— 減法會算錯，這裡釘住', () => {
    const text = build({
      veto: {
        passed: [],
        vetoed: [
          decision('1111', 'attention'),
          decision('1111', 'disposition'),
          decision('1111', 'altered_trading'),
        ],
        countsByRule: { attention: 1, disposition: 1, altered_trading: 1 },
        failedClosed: false,
      },
    });
    expect(text).toContain('L2 擋下 1 檔');
    expect(text).toContain('其中 1 檔踩到多條');
    expect(text).not.toContain('其中 2 檔');
  });

  it('沒有人踩多條時不加那句廢話', () => {
    const text = build({
      veto: {
        passed: [],
        vetoed: [decision('1111', 'attention'), decision('2222', 'disposition')],
        countsByRule: { attention: 1, disposition: 1 },
        failedClosed: false,
      },
    });
    expect(text).toContain('L2 擋下 2 檔');
    expect(text).not.toContain('踩到多條');
  });
});

/**
 * CLAUDE.md：0～N 檔，經常是 0 檔，那是正常且健康的。
 * 但「沒有標的通過三關」與「資料還不夠算不出停損」都顯示 0 檔，意義完全相反：
 * 前者代表系統在運作，後者代表系統還沒準備好。混為一談會讓人誤判。
 *
 * 觸發「資料不足」說法的是風控層的拒絕理由 volatility_unavailable，
 * **不是**交易日數 —— 交易日夠了但個股上市不滿 21 天也會算不出波動率。
 */
describe('0 檔要分清楚是哪一種 0', () => {
  const volMissing: RiskResult = {
    ...NO_RISK,
    countsByReason: { volatility_unavailable: 5 },
  };

  it('算不出波動率時，明講還差幾個交易日', () => {
    const text = build({ risk: volMissing, historyDays: 3, volMinObservations: 20 });
    expect(text).toContain('今日 0 檔');
    expect(text).toContain('不是「沒有機會」');
    expect(text).toContain('需要 21 個交易日，目前累積 3 個');
  });

  it('需要的天數是 volMinObservations + 1，不是它本身', () => {
    const text = build({ risk: volMissing, historyDays: 3, volMinObservations: 20 });
    expect(text).toContain('需要 21 個交易日');
    expect(text).not.toContain('需要 20 個交易日');
  });

  it('資料齊全但沒人過關時，說法完全不同 —— 那是系統在運作', () => {
    const text = build({ risk: NO_RISK });
    expect(text).toContain('今日 0 檔');
    expect(text).toContain('0 檔是正常且健康的');
    expect(text).not.toContain('資料還不夠');
  });
});
