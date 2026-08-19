/**
 * LINE 日報的文字組裝。純函式，不碰網路。
 *
 * 【兩份清單在版面上必須壁壘分明】（CLAUDE.md）
 * 觀察榜是**研究紀錄**，交易訊號才是可執行的。
 * 手機上一眼掃過去很容易混淆，所以：
 *   - 交易訊號放最前面（那是唯一可執行的）
 *   - 觀察榜每次都重申「不是買進建議」
 *   - 0 檔時明講「0 檔是正常的」，並區分「沒有標的通過」與「資料不足」
 *
 * 【AI 揭露是法遵要求，不是禮貌】
 * 歐盟 AI Act 第 50 條與台灣 AI 基本法要求揭露內容由 AI 產生。
 * 每一則日報固定附上，不因版面而省略。
 */

import type { RankedStock, RankingResult } from '../../l1/factors/engine';
import type { ApprovedSignal, RiskResult } from '../../l3/engine';
import type { VetoResult } from '../../l2/types';

export interface DailyReportInput {
  readonly dataAsOf: string;
  readonly ranking: RankingResult;
  readonly watchlist: readonly RankedStock[];
  readonly veto: VetoResult<RankedStock>;
  readonly risk: RiskResult;
  /** 交易日之後累積的交易日數，用來說明波動率還差幾天 */
  readonly historyDays: number;
  readonly volMinObservations: number;
  /** 當月已進場筆數 / 上限 */
  readonly entriesThisMonth: number;
  readonly monthlyEntryCap: number;
}

const MARKET_LABEL: Readonly<Record<string, string>> = { TWSE: '市', TPEx: '櫃' };

function signalBlock(input: DailyReportInput): readonly string[] {
  const lines: string[] = ['━━━ 交易訊號 ━━━'];
  const { risk } = input;

  if (risk.haltedGlobally) {
    lines.push('⛔ 全域限制觸發，今日不出訊號');
    lines.push(risk.haltReason ?? '');
    return lines;
  }

  if (risk.approved.length === 0) {
    lines.push('今日 0 檔。');
    const volUnavailable = risk.countsByReason['volatility_unavailable'] ?? 0;
    if (volUnavailable > 0) {
      const need = input.volMinObservations + 1;
      lines.push('');
      lines.push(`⚠️ 不是「沒有機會」，是資料還不夠：`);
      lines.push(
        `停損距離要用波動率算，需要 ${need} 個交易日，目前累積 ${input.historyDays} 個。`,
      );
      lines.push('不用固定百分比代替，那個停損價會沒有根據。');
    } else {
      lines.push('0 檔是正常且健康的——要同時通過');
      lines.push('因子排序、L2 否決、L3 風控三關。');
    }
    return lines;
  }

  for (const [i, s] of risk.approved.entries()) {
    lines.push(...signalLines(i + 1, s));
  }
  lines.push('');
  lines.push(`當月進場 ${input.entriesThisMonth + risk.approved.length}/${input.monthlyEntryCap} 筆`);
  return lines;
}

function signalLines(rank: number, s: ApprovedSignal): readonly string[] {
  const market = MARKET_LABEL[s.stock.market] ?? s.stock.market;
  return [
    '',
    `${rank}. ${s.stock.code} ${s.stock.name}（${market}）`,
    `　進場 ${s.barrier.entryPrice}　${s.position.shares.toLocaleString()} 股`,
    `　停損 ${s.barrier.stopPrice.toFixed(2)}`,
    `　停利 ${s.barrier.takeProfitPrice.toFixed(2)}`,
    `　${s.barrier.timeExitDays} 個交易日未觸發即平倉`,
    `　部位 ${Math.round(s.position.positionValueTwd).toLocaleString()} 元` +
      `　最多虧 ${Math.round(-Number(s.position.outcome.stopLoss.netPnl.twd)).toLocaleString()} 元`,
  ];
}

function watchlistBlock(input: DailyReportInput): readonly string[] {
  const lines: string[] = ['', '━━━ 觀察榜 Top 5 ━━━', '⚠️ 研究紀錄，不是買進建議'];
  if (input.watchlist.length === 0) {
    lines.push('（今日無可排序的標的）');
    return lines;
  }
  // 【觀察榜不受 L2 影響，但必須標示哪幾檔已被 L2 擋下】
  // 排名純由 L1 產生，那正是它作為對照組的意義——不能因為 L2 擋了就把它拿掉，
  // 否則就沒有東西可以拿來衡量 L2 到底擋對了沒有。
  //
  // 但「這一檔是注意股／處置股」是讀者判斷時該知道的事實。
  // 2026-08-19 使用者實際反映：Dashboard 上第 2 名標著「擋下」，LINE 版本沒有，
  // 只看手機的人不會知道那是處置股。標示只是補上事實，不會讓觀察榜變成買進建議。
  const blockedBy = new Map<string, string[]>();
  for (const v of input.veto.vetoed) {
    const label = RULE_SHORT[v.ruleId] ?? v.ruleId;
    const existing = blockedBy.get(v.code);
    if (existing === undefined) {
      blockedBy.set(v.code, [label]);
    } else if (!existing.includes(label)) {
      existing.push(label);
    }
  }

  for (const [i, s] of input.watchlist.entries()) {
    const market = MARKET_LABEL[s.market] ?? s.market;
    lines.push(
      `${i + 1}. ${s.code} ${s.name}（${market}）${s.close}`,
      `　　分數 ${s.compositeScore.toFixed(3)}　因子 ${s.realFactorCount}/${input.ranking.activeFactors.length}`,
    );
    const blocked = blockedBy.get(s.code);
    if (blocked !== undefined) {
      lines.push(`　　⛔ 已被 L2 擋下：${blocked.join('、')}`);
    }
  }
  return lines;
}

function systemBlock(input: DailyReportInput): readonly string[] {
  const { ranking, veto, risk } = input;
  const vetoedCodes = new Set(veto.vetoed.map((v) => v.code));
  const counts = Object.entries(veto.countsByRule)
    .map(([rule, n]) => `${RULE_SHORT[rule] ?? rule}${n}`)
    .join(' ');

  // 踩到不只一條規則的檔數。**不是**「規則觸發次數 − 相異檔數」——
  // 一檔踩三條時那個減法會算出 2，但實際只有 1 檔踩多條。
  const hitsPerCode = new Map<string, number>();
  for (const v of veto.vetoed) {
    hitsPerCode.set(v.code, (hitsPerCode.get(v.code) ?? 0) + 1);
  }
  const multiRuleCount = [...hitsPerCode.values()].filter((n) => n > 1).length;

  const lines = [
    '',
    '━━━ 系統狀態 ━━━',
    `排序池 ${ranking.rankedCount.toLocaleString()} 檔`,
    // 【為什麼括號裡的數字加起來會大於前面那個】
    // 前者是「幾檔被擋」，後者是「幾次規則觸發」。同一檔可能既是注意股又變更交易。
    // 兩個數字都對，但擺在一起看起來像算錯，所以差額要明講。
    // （2026-08-19：51 檔 vs 處置13＋注意17＋變更23＝53，就是這個情況。）
    `L2 擋下 ${vetoedCodes.size} 檔${counts === '' ? '' : `（${counts}）`}` +
      (multiRuleCount > 0 ? `　其中 ${multiRuleCount} 檔踩到多條` : ''),
    `L3 核准 ${risk.approved.length} 檔`,
  ];
  if (ranking.inactiveFactors.length > 0) {
    lines.push(`停用因子 ${ranking.inactiveFactors.length}／${ranking.activeFactors.length + ranking.inactiveFactors.length}`);
  }
  return lines;
}

const RULE_SHORT: Readonly<Record<string, string>> = {
  attention: '注意',
  disposition: '處置',
  suspended: '暫停',
  altered_trading: '變更',
  source_unavailable: '資料缺',
};

const FOOTER = [
  '',
  '━━━ 紀錄指令 ━━━',
  '/rec 買 2330 100 580.5',
  '/rec 觀望 6121 想再等等',
  '/help　完整說明',
  '',
  '本報告由 AI 系統自動產生',
  '（歐盟 AI Act 第 50 條、台灣 AI 基本法）',
  '不構成投資建議。v1 不具備下單功能。',
];

export function buildDailyReport(input: DailyReportInput): string {
  return [
    `📊 台股分析日報　${input.dataAsOf}`,
    '',
    ...signalBlock(input),
    ...watchlistBlock(input),
    ...systemBlock(input),
    ...FOOTER,
  ].join('\n');
}

/** 系統狀態查詢（/status）的回覆 */
export function buildStatusText(input: DailyReportInput): string {
  const need = input.volMinObservations + 1;
  return [
    '🔧 系統狀態',
    '',
    `最新資料日　${input.dataAsOf}`,
    `累積交易日　${input.historyDays} 個`,
    `波動率估計　${input.historyDays >= need ? '已可用' : `還差 ${need - input.historyDays} 個交易日`}`,
    `啟用因子　　${input.ranking.activeFactors.length} 個`,
    `停用因子　　${input.ranking.inactiveFactors.map((f) => f.factorKey).join('、') || '無'}`,
    `當月進場　　${input.entriesThisMonth}/${input.monthlyEntryCap} 筆`,
    '',
    'v1 不下單。自動下單需通過 G1–G5 五道閘門。',
  ].join('\n');
}
