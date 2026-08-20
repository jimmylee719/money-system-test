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

import type { FactorScore, RankedStock, RankingResult } from '../../l1/factors/engine';
import type { RiskResult } from '../../l3/engine';
import type { VetoDecision, VetoResult } from '../../l2/types';
import { RULE_SHORT, buildDailyReport } from '../line/report';
import { RULE_SPECS } from '../../l2/rules';
import type { DailyReportInput } from '../line/report';

function stock(
  code: string,
  name: string,
  score: number,
  quote: Partial<Pick<RankedStock, 'close' | 'change' | 'changeNote' | 'volumeShares' | 'factorScores'>> = {},
): RankedStock {
  return {
    code,
    market: 'TWSE',
    name,
    close: quote.close ?? 100,
    compositeScore: score,
    realFactorCount: 4,
    factorScores: quote.factorScores ?? [],
    change: quote.change ?? null,
    changeNote: quote.changeNote ?? null,
    volumeShares: quote.volumeShares ?? null,
    turnoverValue: null,
  };
}

function factorScore(factorKey: string, rawValue: number | null, imputed = false): FactorScore {
  return {
    factorKey,
    direction: 'higher_is_better',
    rawValue,
    winsorizedValue: rawValue,
    score: 0.5,
    imputed,
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
    expect(text).toContain('② L2 擋下　2 檔');
    expect(text).toContain('1 檔同時踩到多條，故分項合計 3 大於 2');
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
    expect(text).toContain('② L2 擋下　1 檔');
    expect(text).toContain('1 檔同時踩到多條，故分項合計 3 大於 1');
    expect(text).not.toContain('2 檔同時踩到多條');
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
    expect(text).toContain('② L2 擋下　2 檔');
    expect(text).not.toContain('同時踩到多條');
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

/**
 * 2026-08-20 使用者回饋：「Line 收到的訊息我看不太懂」。
 * 要求補上昨收、今收、漲跌、成交量，並把系統狀態一項一行講清楚。
 *
 * 這一組釘住的是「不能為了好看而編造」：
 * 除權息日不得反推昨收、補值因子不得當成公司的數字顯示。
 */
describe('觀察榜要看得懂：昨收、今收、漲跌、成交量', () => {
  const s = stock('2542', '興富發', 0.972, {
    close: 48.15,
    change: 0.4,
    volumeShares: 13_205_723,
  });

  it('顯示今日收盤與漲跌金額、漲跌幅', () => {
    const text = build({ watchlist: [s] });
    expect(text).toContain('收盤 48.15');
    expect(text).toContain('▲0.40');
    expect(text).toContain('+0.84%');
  });

  it('昨收由今收減漲跌反推，不另外去查', () => {
    expect(build({ watchlist: [s] })).toContain('昨收 47.75');
  });

  it('成交量以「張」顯示，來源是股數', () => {
    // 13,205,723 股 ÷ 1000 = 13,206 張
    expect(build({ watchlist: [s] })).toContain('成交 13,206 張');
  });

  it('下跌時用 ▼ 並顯示負的漲跌幅', () => {
    const down = stock('6213', '聯茂', 0.9, { close: 484, change: -4 });
    const text = build({ watchlist: [down] });
    expect(text).toContain('▼4.00');
    expect(text).toContain('-0.82%');
  });

  it('除權息日不得反推昨收 —— 那天的漲跌不是跟昨收比的', () => {
    const ex = stock('1101', '台泥', 0.9, { close: 30, change: null, changeNote: '除息' });
    const text = build({ watchlist: [ex] });
    expect(text).toContain('除息');
    expect(text).toContain('不可與昨收直接比較');
    expect(text).toContain('昨收 —');
    expect(text).not.toContain('昨收 30');
  });

  it('沒有成交量資料時顯示破折號，不顯示 0 張', () => {
    const noVol = stock('9999', '測試', 0.9, { close: 10, change: 0 });
    const text = build({ watchlist: [noVol] });
    expect(text).toContain('成交 —');
    expect(text).not.toContain('成交 0 張');
  });

  it('平盤說「平盤」，不寫成看起來像負號的 —0.00', () => {
    const flat = stock('9946', '三發地產', 0.9, { close: 18.85, change: 0, volumeShares: 227_000 });
    const text = build({ watchlist: [flat] });
    expect(text).toContain('收盤 18.85　平盤');
    expect(text).toContain('昨收 18.85');
    expect(text).not.toContain('—0.00');
  });

  it('收盤與昨收的小數位數一致，不會一個 166.5 一個 160.00', () => {
    const s2 = stock('4961', '天鈺', 0.9, { close: 166.5, change: 6.5 });
    const text = build({ watchlist: [s2] });
    expect(text).toContain('收盤 166.50');
    expect(text).toContain('昨收 160.00');
  });
});

describe('觀察榜要說明「為什麼上榜」', () => {
  const withFactors = stock('2542', '興富發', 0.972, {
    close: 48.15,
    change: 0.4,
    factorScores: [
      factorScore('rev_yoy_momentum_v1', 202.646),
      factorScore('foreign_net_buy_ratio_v1', 0.0960786),
      factorScore('margin_balance_change_v1', -0.025641),
    ],
  });

  it('用白話標籤而不是 factorKey', () => {
    const text = build({ watchlist: [withFactors] });
    expect(text).toContain('月營收年增 +202.6%');
    expect(text).toContain('外資買超 佔成交量 +9.6%');
    expect(text).toContain('融資餘額 -2.6%');
    expect(text).not.toContain('rev_yoy_momentum_v1');
  });

  it('補值的因子一律不顯示 —— 那是系統的假設，不是公司的數字', () => {
    const imputed = stock('3090', '日電貿', 0.9, {
      close: 161.5,
      change: 1,
      factorScores: [
        factorScore('rev_yoy_momentum_v1', 50),
        factorScore('trust_net_buy_ratio_v1', 0.5, true),
      ],
    });
    const text = build({ watchlist: [imputed] });
    expect(text).toContain('月營收年增 +50.0%');
    expect(text).not.toContain('投信買超');
  });
});

describe('系統狀態要一項一行、看得出是一條漏斗', () => {
  const veto: VetoResult<RankedStock> = {
    passed: [],
    vetoed: [
      decision('1111', 'attention'),
      decision('1111', 'disposition'),
      decision('2222', 'altered_trading'),
    ],
    countsByRule: { attention: 1, disposition: 1, altered_trading: 1 },
    failedClosed: false,
  };

  it('四個項目各自成行並編號', () => {
    const text = build({ veto });
    expect(text).toContain('① 排序池');
    expect(text).toContain('② L2 擋下');
    expect(text).toContain('③ L3 核准');
    expect(text).toContain('④ 停用因子');
  });

  it('每一項都附一句說明它是什麼', () => {
    const text = build({ veto });
    expect(text).toContain('今天資料齊全、算得出分數的股票');
    expect(text).toContain('官方公告的異常股');
    expect(text).toContain('真正可執行的數量');
  });

  it('分項合計大於被擋檔數時，把差額的來源講明', () => {
    const text = build({ veto });
    expect(text).toContain('② L2 擋下　2 檔');
    expect(text).toContain('1 檔同時踩到多條，故分項合計 3 大於 2');
  });

  it('停用因子要寫出是哪一個、為什麼，不能只寫 1／5', () => {
    const text = build({ veto });
    expect(text).toContain('五日漲跌：交易日不足');
    expect(text).not.toMatch(/停用因子\s*1／5\s*\n\s*\n/u);
  });
});

/**
 * 2026-08-20 實際發生：新增 margin_suspension 規則後忘了補中文標籤，
 * 日報上出現「處置13 margin_suspension16 注意16」。
 * 數字是對的，但一般人看不懂那是什麼。
 */
describe('每一條否決規則都要有中文短標籤', () => {
  it('RULE_SPECS 裡的每個規則都在 RULE_SHORT 有對應', () => {
    const missing = RULE_SPECS.map((s) => s.id).filter((id) => RULE_SHORT[id] === undefined);
    // source_unavailable 與 llm_material_news 也必須有，因為它們同樣會出現在計數裡
    expect(missing).toEqual([]);
  });

  it('標籤都是中文，不會漏成 factorKey 那樣的英文代號', () => {
    for (const [id, label] of Object.entries(RULE_SHORT)) {
      expect(label, `${id} 的標籤`).not.toMatch(/^[a-z_]+$/u);
      expect(label.length, `${id} 的標籤`).toBeGreaterThan(0);
    }
  });

  it('停資停券在日報上顯示為「停券」而不是 margin_suspension', () => {
    const text = build({
      veto: {
        passed: [],
        vetoed: [decision('1111', 'margin_suspension')],
        countsByRule: { margin_suspension: 1 },
        failedClosed: false,
      },
    });
    expect(text).toContain('停券1');
    expect(text).not.toContain('margin_suspension');
  });
});
