/**
 * L1 因子計算與排序引擎。純函式，無 I/O。
 *
 * 【參數一律從已登記的定義讀取，不在這裡寫死】
 * 縮尾百分位、回溯天數、假設方向全部取自 `V1_FACTORS` 的 definition，
 * 也就是取自那份算出 `definition_hash` 的物件本身。
 * 公式的「形狀」是程式碼，但每個實作都帶 `valueExpr` 字串，
 * 由測試強制它與登記定義的 `value` 逐字相同——改了公式沒改登記，測試就紅。
 *
 * 【合成方式：等權名次平均，零自由參數】
 * 不做權重最佳化。權重是連續且無上限的自由參數，看了結果再調就是回測後調參，
 * 那正是 factor_registry 整張表存在的理由。
 *
 * 【缺值補中性值 0.5，而不是排除該檔】
 * 若改成「缺一個因子就整檔排除」，每天的排序池會隨資料涵蓋率大幅變動，
 * 跨日之間無法比較，等於毀掉觀察榜唯一的用途（累積樣本檢驗排序有無預測力）。
 * 補 0.5（＝橫斷面正中央）的效果是**收縮**：資料越少的股票越被拉回中間，
 * 越難進 Top 5。缺資料因此只會讓人更不容易被選上，不會反過來製造名次。
 * 每一檔實際用了幾個真實因子值都會逐筆記錄，供 P12 稽核。
 */

import type { FactorRegistrationInput, HypothesisDirection } from '../../factors/types';
import type { DailyQuote, InstitutionalRow, L1Market, MarginRow, MonthlyRevenueRow } from '../types';
import type { Universe } from '../universe';
import { isTradable } from '../universe';
import {
  FOREIGN_NET_BUY_RATIO_V1,
  MARGIN_BALANCE_CHANGE_V1,
  REV_YOY_MOMENTUM_V1,
  SHORT_TERM_REVERSAL_5D_V1,
  TRUST_NET_BUY_RATIO_V1,
  V1_FACTORS,
} from './definitions';
import { scoreCrossSection } from './scoring';

/** 引擎版本。合成規則若有任何改變必須換版本號，歷史紀錄才可回溯。 */
export const ENGINE_VERSION = 'l1-equal-weight-rank-v1';

/** 缺值時補的中性分數＝橫斷面正中央 */
export const NEUTRAL_SCORE = 0.5;

/** 觀察榜固定檔數。CLAUDE.md：每日固定 5 檔。 */
export const WATCHLIST_SIZE = 5;

// ── 計算所需的當日事實 ────────────────────────────────────────────────────────

export interface FactorContext {
  /** 全部資料共用的交易日，由呼叫端事先對齊並驗證過 */
  readonly dataAsOf: string;
  readonly quoteByCode: ReadonlyMap<string, DailyQuote>;
  readonly institutionalByCode: ReadonlyMap<string, InstitutionalRow>;
  readonly marginByCode: ReadonlyMap<string, MarginRow>;
  /** 已依 as_of_rule 選出「reportDate 不晚於當日的最新一期」 */
  readonly revenueByCode: ReadonlyMap<string, MonthlyRevenueRow>;
  /**
   * 系統實際擁有的交易日，升冪，最後一筆即 `dataAsOf`。
   * 由實際存在的快照決定，**不從日曆推算**——推算會撞到假日與颱風假。
   */
  readonly historyDates: readonly string[];
  /**
   * code → 與 `historyDates` **等長且逐位對齊**的行情，該日無資料為 null。
   *
   * 【為什麼要對齊而不是只存有值的那幾天】
   * 若某檔中間停牌一天，只存有值的天數會讓「最後 6 筆」實際跨了 7 個交易日，
   * 回溯期間就錯了。錯誤不會拋例外，只會靜默算出錯的報酬率。
   * 對齊後缺哪一天一目了然，該檔當期直接排除。
   */
  readonly historyByCode: ReadonlyMap<string, readonly (DailyQuote | null)[]>;
}

// ── 因子實作 ─────────────────────────────────────────────────────────────────

interface FactorImpl {
  readonly factorKey: string;
  /** 必須與登記定義的 `value` 逐字相同 —— engine.test.ts 會強制比對 */
  readonly valueExpr: string;
  /** 這個因子今天有沒有資料可算。回 null 代表可算。 */
  inactiveReason(ctx: FactorContext): string | null;
  compute(ctx: FactorContext, code: string): number | null;
}

/** 所有因子共用的資料有效性條件（BASE_VALIDITY）：有收盤價且有成交量 */
function validQuote(ctx: FactorContext, code: string): DailyQuote | null {
  const quote = ctx.quoteByCode.get(code);
  if (quote === undefined || !isTradable(quote)) {
    return null;
  }
  return quote;
}

function readWinsorize(factor: FactorRegistrationInput): { lower: number; upper: number } {
  const w = factor.definition['winsorize'] as { lower_pct: number; upper_pct: number } | undefined;
  if (w === undefined) {
    throw new Error(`${factor.factorKey} 的登記定義沒有 winsorize，無法計算`);
  }
  return { lower: w.lower_pct, upper: w.upper_pct };
}

function readLookback(factor: FactorRegistrationInput): number {
  const n = factor.definition['lookback_trading_days'];
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${factor.factorKey} 的登記定義沒有合法的 lookback_trading_days`);
  }
  return n;
}

const REVERSAL_LOOKBACK = readLookback(SHORT_TERM_REVERSAL_5D_V1);

const REV_YOY_IMPL: FactorImpl = {
  factorKey: REV_YOY_MOMENTUM_V1.factorKey,
  valueExpr: 'monthly_revenue.yoyPct',
  inactiveReason: (ctx) =>
    ctx.revenueByCode.size === 0 ? '當日沒有 reportDate 不晚於今日的月營收資料' : null,
  compute: (ctx, code) => {
    if (validQuote(ctx, code) === null) {
      return null;
    }
    return ctx.revenueByCode.get(code)?.yoyPct ?? null;
  },
};

const TRUST_NET_IMPL: FactorImpl = {
  factorKey: TRUST_NET_BUY_RATIO_V1.factorKey,
  valueExpr: 'institutional.trustNet / quote.volumeShares',
  inactiveReason: (ctx) => (ctx.institutionalByCode.size === 0 ? '當日沒有三大法人資料' : null),
  compute: (ctx, code) => {
    const quote = validQuote(ctx, code);
    if (quote === null) {
      return null;
    }
    const trustNet = ctx.institutionalByCode.get(code)?.trustNet;
    if (trustNet === undefined || trustNet === null) {
      return null;
    }
    return trustNet / quote.volumeShares!;
  },
};

const MARGIN_CHANGE_IMPL: FactorImpl = {
  factorKey: MARGIN_BALANCE_CHANGE_V1.factorKey,
  valueExpr: '(margin.marginBalance - margin.marginBalancePrevDay) / margin.marginBalancePrevDay',
  inactiveReason: (ctx) => (ctx.marginByCode.size === 0 ? '當日沒有融資融券餘額資料' : null),
  compute: (ctx, code) => {
    if (validQuote(ctx, code) === null) {
      return null;
    }
    const row = ctx.marginByCode.get(code);
    if (row === undefined) {
      return null;
    }
    const { marginBalance, marginBalancePrevDay } = row;
    // 登記定義的 validity：marginBalancePrevDay > 0 且 marginBalance != null
    if (marginBalance === null || marginBalancePrevDay === null || marginBalancePrevDay <= 0) {
      return null;
    }
    return (marginBalance - marginBalancePrevDay) / marginBalancePrevDay;
  },
};

const REVERSAL_IMPL: FactorImpl = {
  factorKey: SHORT_TERM_REVERSAL_5D_V1.factorKey,
  valueExpr: 'quote.close[t] / quote.close[t-5] - 1',
  inactiveReason: (ctx) =>
    ctx.historyDates.length < REVERSAL_LOOKBACK + 1
      ? `需要 ${REVERSAL_LOOKBACK + 1} 個交易日的行情快照，目前只有 ${ctx.historyDates.length} 個`
      : null,
  compute: (ctx, code) => {
    if (validQuote(ctx, code) === null) {
      return null;
    }
    const history = ctx.historyByCode.get(code);
    if (history === undefined || history.length < REVERSAL_LOOKBACK + 1) {
      return null;
    }
    const window = history.slice(-(REVERSAL_LOOKBACK + 1));
    for (const day of window) {
      // 登記定義的 validity：回溯期間內每日皆有收盤價，且任一日有除權息註記即排除
      if (day === null || day.close === null || day.close <= 0 || day.changeNote !== null) {
        return null;
      }
    }
    const past = window[0]!.close!;
    const now = window[window.length - 1]!.close!;
    return now / past - 1;
  },
};

const FOREIGN_NET_IMPL: FactorImpl = {
  factorKey: FOREIGN_NET_BUY_RATIO_V1.factorKey,
  valueExpr: 'institutional.foreignNet / quote.volumeShares',
  inactiveReason: (ctx) => (ctx.institutionalByCode.size === 0 ? '當日沒有三大法人資料' : null),
  compute: (ctx, code) => {
    const quote = validQuote(ctx, code);
    if (quote === null) {
      return null;
    }
    const foreignNet = ctx.institutionalByCode.get(code)?.foreignNet;
    if (foreignNet === undefined || foreignNet === null) {
      return null;
    }
    return foreignNet / quote.volumeShares!;
  },
};

/** factor_key → 實作。登記了但沒有實作（或反之）會在 rankUniverse 直接拋錯。 */
export const FACTOR_IMPLS: ReadonlyMap<string, FactorImpl> = new Map(
  [REV_YOY_IMPL, TRUST_NET_IMPL, MARGIN_CHANGE_IMPL, REVERSAL_IMPL, FOREIGN_NET_IMPL].map((i) => [
    i.factorKey,
    i,
  ]),
);

// ── 月營收的 as_of 選期規則 ──────────────────────────────────────────────────

/**
 * 依登記的 as_of_rule 選出每檔可用的最新一期月營收：
 * 「使用 reportDate 不晚於當日的最新一期，禁止使用尚未公布的期別」。
 *
 * ⚠️ 這是防前視偏誤的關鍵。8/15 才公布 7 月營收，
 * 若在 8/10 就拿 7 月數字排序，回測會漂亮得不像話——因為作弊了。
 */
export function selectLatestRevenue(
  rows: readonly MonthlyRevenueRow[],
  dataAsOf: string,
): ReadonlyMap<string, MonthlyRevenueRow> {
  const byCode = new Map<string, MonthlyRevenueRow>();
  for (const row of rows) {
    if (row.reportDate > dataAsOf) {
      continue; // 尚未公布，不得使用
    }
    const current = byCode.get(row.code);
    if (
      current === undefined ||
      row.period > current.period ||
      (row.period === current.period && row.reportDate > current.reportDate)
    ) {
      byCode.set(row.code, row);
    }
  }
  return byCode;
}

// ── 排序結果 ─────────────────────────────────────────────────────────────────

export interface FactorScore {
  readonly factorKey: string;
  readonly direction: HypothesisDirection;
  /** 未縮尾的原始值。null 代表這檔沒有這個因子的資料。 */
  readonly rawValue: number | null;
  /** 縮尾後的值（名次不受縮尾影響，此值供 P12 檢定使用） */
  readonly winsorizedValue: number | null;
  /** 0～1，已套用假設方向 */
  readonly score: number;
  /** true 代表這個分數是補的中性值，不是算出來的 */
  readonly imputed: boolean;
}

export interface RankedStock {
  readonly code: string;
  readonly market: L1Market;
  readonly name: string;
  readonly close: number;
  /** 等權平均分數（含補值），0～1 */
  readonly compositeScore: number;
  /** 實際算得出來的因子數（不含補值） */
  readonly realFactorCount: number;
  readonly factorScores: readonly FactorScore[];
}

export interface InactiveFactor {
  readonly factorKey: string;
  readonly reason: string;
}

export interface RankingResult {
  readonly dataAsOf: string;
  readonly engineVersion: string;
  readonly activeFactors: readonly string[];
  readonly inactiveFactors: readonly InactiveFactor[];
  readonly universeSize: number;
  /** 標的池中當日有收盤價且有成交量者 */
  readonly tradableCount: number;
  /** 實際進入排序的檔數（至少有一個真實因子值） */
  readonly rankedCount: number;
  /** 可交易但五個因子全都沒資料，故未進排序 */
  readonly excludedNoFactorData: number;
  /** factorKey → 有真實值的檔數 */
  readonly coverage: Readonly<Record<string, number>>;
  /** 依 compositeScore 降冪；平手以代號升冪決勝，不留隨機性 */
  readonly ranked: readonly RankedStock[];
}

/**
 * 對整個標的池計算因子、排名、等權合成。
 *
 * @param factors 預設為 V1_FACTORS。傳入者必須是**已登記**的定義物件；
 *                本函式讀它的 definition 取參數，不自行決定任何數值。
 */
export function rankUniverse(
  universe: Universe,
  ctx: FactorContext,
  factors: readonly FactorRegistrationInput[] = V1_FACTORS,
): RankingResult {
  // 1. 登記與實作必須一一對應
  const impls = factors.map((factor) => {
    const impl = FACTOR_IMPLS.get(factor.factorKey);
    if (impl === undefined) {
      throw new Error(
        `因子 ${factor.factorKey} 已登記但引擎沒有實作。` +
          '登記與計算必須一致，缺一不可，故直接停止而非略過。',
      );
    }
    return { factor, impl };
  });

  // 2. 當日可算的因子
  const activeFactors: string[] = [];
  const inactiveFactors: InactiveFactor[] = [];
  const active: typeof impls = [];
  for (const entry of impls) {
    const reason = entry.impl.inactiveReason(ctx);
    if (reason === null) {
      activeFactors.push(entry.factor.factorKey);
      active.push(entry);
    } else {
      inactiveFactors.push({ factorKey: entry.factor.factorKey, reason });
    }
  }

  // 3. 候選＝標的池成員且當日可交易
  const candidates: string[] = [];
  for (const code of universe.byCode.keys()) {
    const quote = ctx.quoteByCode.get(code);
    if (quote !== undefined && isTradable(quote)) {
      candidates.push(code);
    }
  }
  candidates.sort();

  const coverage: Record<string, number> = {};
  for (const entry of impls) {
    coverage[entry.factor.factorKey] = 0;
  }

  // 4. 逐因子做橫斷面：只有「算得出值」的股票進入該因子的縮尾與名次池
  const scoreByFactor = new Map<string, Map<string, { raw: number; wins: number; score: number }>>();
  for (const { factor, impl } of active) {
    const codes: string[] = [];
    const values: number[] = [];
    for (const code of candidates) {
      const value = impl.compute(ctx, code);
      if (value !== null && Number.isFinite(value)) {
        codes.push(code);
        values.push(value);
      }
    }
    coverage[factor.factorKey] = codes.length;

    const { lower, upper } = readWinsorize(factor);
    const { winsorized, scores } = scoreCrossSection(
      values,
      factor.hypothesisDirection,
      lower,
      upper,
    );

    const map = new Map<string, { raw: number; wins: number; score: number }>();
    for (let i = 0; i < codes.length; i += 1) {
      map.set(codes[i]!, { raw: values[i]!, wins: winsorized[i]!, score: scores[i]! });
    }
    scoreByFactor.set(factor.factorKey, map);
  }

  // 5. 合成
  const ranked: RankedStock[] = [];
  let excludedNoFactorData = 0;

  for (const code of candidates) {
    const entry = universe.byCode.get(code)!;
    const quote = ctx.quoteByCode.get(code)!;

    const factorScores: FactorScore[] = [];
    let sum = 0;
    let realCount = 0;

    for (const { factor } of impls) {
      const isActive = activeFactors.includes(factor.factorKey);
      const hit = isActive ? scoreByFactor.get(factor.factorKey)!.get(code) : undefined;

      if (hit === undefined) {
        factorScores.push({
          factorKey: factor.factorKey,
          direction: factor.hypothesisDirection,
          rawValue: null,
          winsorizedValue: null,
          score: NEUTRAL_SCORE,
          imputed: true,
        });
        if (isActive) {
          sum += NEUTRAL_SCORE;
        }
      } else {
        factorScores.push({
          factorKey: factor.factorKey,
          direction: factor.hypothesisDirection,
          rawValue: hit.raw,
          winsorizedValue: hit.wins,
          score: hit.score,
          imputed: false,
        });
        sum += hit.score;
        realCount += 1;
      }
    }

    // 一個真實因子值都沒有的股票不進排序：它不帶任何資訊，
    // 全部補 0.5 會讓它拿到剛好中位的分數，混進來只是雜訊。
    if (realCount === 0) {
      excludedNoFactorData += 1;
      continue;
    }

    ranked.push({
      code,
      market: entry.market,
      name: entry.name,
      close: quote.close!,
      compositeScore: active.length === 0 ? NEUTRAL_SCORE : sum / active.length,
      realFactorCount: realCount,
      factorScores,
    });
  }

  // 平手以代號升冪決勝：規則寫死才可重現，不依賴輸入順序
  ranked.sort((a, b) => b.compositeScore - a.compositeScore || a.code.localeCompare(b.code));

  return {
    dataAsOf: ctx.dataAsOf,
    engineVersion: ENGINE_VERSION,
    activeFactors,
    inactiveFactors,
    universeSize: universe.size,
    tradableCount: candidates.length,
    rankedCount: ranked.length,
    excludedNoFactorData,
    coverage,
    ranked,
  };
}

/**
 * 觀察榜 Top N。
 *
 * ⚠️ CLAUDE.md：觀察榜是**研究紀錄，不是買進建議**。
 * 交易訊號要另外通過 L2 否決與 L3 風控，經常是 0 檔。
 */
export function watchlist(result: RankingResult, size: number = WATCHLIST_SIZE): readonly RankedStock[] {
  return result.ranked.slice(0, size);
}
