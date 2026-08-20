/**
 * P11.12 — 把系統內部的數字翻成一般人看得懂的話。
 *
 * 【為什麼要獨立成一支，而不是各畫面自己寫】
 * 這幾天連續出過三次「同一件事兩個畫面說法不同」：
 * 觀察榜有沒有標 L2、gold_set 應否決是 7 還是 9、L2b 未判到底代表什麼。
 * 每一次的成因都一樣 —— 兩邊各算各的、各寫各的。
 * 顯示規則只准有一份實作，LINE 日報與 Dashboard 都從這裡取。
 *
 * 【這一層只做翻譯，不做判斷】（CLAUDE.md 鐵則 2：事實／推論分開標示）
 * 這裡輸出的每一個數字都直接來自官方資料或已登記因子的原始值，
 * 不推論漲跌原因、不預測後續、不給任何買賣傾向的措辭。
 * 「外資買超 9.6%」是事實；「所以會漲」是推論，本模組永遠不寫後者。
 */

import type { FactorScore } from '../l1/factors/engine';

/** 一張 = 1000 股。TWSE `TradeVolume` 與 TPEx `TradingShares` 都以股為單位。 */
export const SHARES_PER_LOT = 1000;

export interface PriceMove {
  readonly close: number;
  /** 漲跌（元）。null 代表官方沒給或不是數值。 */
  readonly change: number | null;
  /** 官方漲跌欄的非數值註記，逐字保留（如 `除權`、`除息`） */
  readonly note: string | null;
  /**
   * 前一交易日收盤價。
   * ⚠️ 除權息日一律為 null —— 那天的 change 是相對於除權息參考價，
   * 不是相對於昨天的收盤，`close − change` 會算出一個錯的「昨收」。
   */
  readonly prevClose: number | null;
  /** 漲跌幅（%）。前一交易日收盤取不到時為 null。 */
  readonly pct: number | null;
  readonly arrow: '▲' | '▼' | '—' | '';
  /** 給人看的一行，例如「▲0.40（+0.84%）」 */
  readonly text: string;
}

function fmt(value: number, digits: number): string {
  return value.toFixed(digits);
}

/** 帶正負號的百分比，例如 `+0.84%`、`-2.56%` */
export function signedPct(value: number, digits = 2): string {
  return `${value >= 0 ? '+' : ''}${fmt(value, digits)}%`;
}

export function priceMove(
  close: number,
  change: number | null,
  changeNote: string | null,
): PriceMove {
  // 除權息日：官方的 change 不是跟昨收比的，反推昨收會得到錯的數字。
  // 寧可說「不可比較」，不要給一個看起來很合理的錯誤值。
  const exRight = changeNote !== null && changeNote.trim() !== '';
  if (change === null || exRight) {
    return {
      close,
      change,
      note: changeNote,
      prevClose: null,
      pct: null,
      arrow: '',
      text: exRight
        ? `${changeNote!.trim()}（當日漲跌不可與昨收直接比較）`
        : '漲跌資料缺漏',
    };
  }

  const prevClose = close - change;
  const pct = prevClose === 0 ? null : (change / prevClose) * 100;
  const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '—';
  const magnitude = fmt(Math.abs(change), 2);

  // 平盤直接說「平盤」。寫成「—0.00（+0.00%）」既難讀，
  // 前面那個破折號還會被當成負號。
  const text =
    change === 0
      ? '平盤'
      : pct === null
        ? `${arrow}${magnitude}`
        : `${arrow}${magnitude}（${signedPct(pct)}）`;

  return { close, change, note: changeNote, prevClose, pct, arrow, text };
}

/**
 * 股價一律兩位小數。
 * 台股最小跳動單位到 0.01 為止，兩位小數不會失真；
 * 而「收盤 166.5／昨收 160.00」這種位數不一致，看起來像兩個不同來源的數字。
 */
export function formatPrice(value: number | null): string {
  return value === null ? '—' : fmt(value, 2);
}

/** 成交股數 → 張。取不到時回 null，不要拿 0 假裝成交量是零。 */
export function toLots(volumeShares: number | null): number | null {
  return volumeShares === null ? null : volumeShares / SHARES_PER_LOT;
}

export function formatLots(volumeShares: number | null): string {
  const lots = toLots(volumeShares);
  return lots === null ? '—' : `${Math.round(lots).toLocaleString('en-US')} 張`;
}

/** 成交金額（元）→ 億／萬。金額動輒十位數，原樣顯示沒有人讀得出來。 */
export function formatMoney(twd: number | null): string {
  if (twd === null) {
    return '—';
  }
  const abs = Math.abs(twd);
  if (abs >= 1e8) {
    return `${fmt(twd / 1e8, 2)} 億`;
  }
  if (abs >= 1e4) {
    return `${fmt(twd / 1e4, 1)} 萬`;
  }
  return `${Math.round(twd).toLocaleString('en-US')} 元`;
}

export interface PlainFactor {
  /** 日報用的短標籤 */
  readonly label: string;
  /** Dashboard 用的一句白話：這個數字在講什麼 */
  readonly meaning: string;
  /** 假設方向，須與 definitions.ts 的 hypothesisDirection 一致（有測試綁住） */
  readonly betterWhen: 'higher' | 'lower';
  /** 原始值 → 顯示字串 */
  readonly format: (rawValue: number) => string;
}

/**
 * 每個已登記因子的白話說明。
 *
 * ⚠️ 新增因子時這裡也必須補一筆，否則 explain.test.ts 會失敗。
 *    那是刻意的：一個沒有人看得懂的因子出現在日報上，等於沒有揭露。
 * ⚠️ betterWhen 必須與 definitions.ts 的 hypothesisDirection 相同，
 *    測試會逐一比對。方向講反會讓人把「利空」讀成「利多」。
 */
export const PLAIN_FACTORS: Readonly<Record<string, PlainFactor>> = {
  rev_yoy_momentum_v1: {
    label: '月營收年增',
    meaning:
      '公司上個月的營收，比去年同一個月增加或減少多少。依法每月十日前必須公布，' +
      '是最早能看到的營運事實，比財報早一季以上。',
    betterWhen: 'higher',
    format: (v) => signedPct(v, 1),
  },
  trust_net_buy_ratio_v1: {
    label: '投信買超',
    meaning:
      '國內基金（投信）當天淨買進的股數，佔全天成交量的比例。' +
      '基金建倉必須分批進行以免衝擊價格，所以單日買超常會延續數日。',
    betterWhen: 'higher',
    format: (v) => `佔成交量 ${signedPct(v * 100, 1)}`,
  },
  foreign_net_buy_ratio_v1: {
    label: '外資買超',
    meaning: '外資當天淨買進的股數，佔全天成交量的比例。',
    betterWhen: 'higher',
    format: (v) => `佔成交量 ${signedPct(v * 100, 1)}`,
  },
  margin_balance_change_v1: {
    label: '融資餘額',
    meaning:
      '市場上「借錢買這檔股票」的總額，比前一天增減多少。' +
      '本系統假設融資增加是負面訊號（散戶追高的槓桿部位），所以這個數字越低排名越前面。',
    betterWhen: 'lower',
    format: (v) => signedPct(v * 100, 1),
  },
  short_term_reversal_5d_v1: {
    label: '五日漲跌',
    meaning:
      '最近五個交易日的累積漲跌幅。本系統假設短線漲多會回檔，' +
      '所以這個數字越低排名越前面。',
    betterWhen: 'lower',
    format: (v) => signedPct(v * 100, 1),
  },
};

export interface ExplainedFactor {
  readonly factorKey: string;
  readonly label: string;
  readonly valueText: string;
  readonly betterWhen: 'higher' | 'lower';
}

/**
 * 把一檔股票的因子分數翻成可顯示的清單。
 *
 * **補值（imputed）的因子一律不顯示。** 那是「這檔沒有這項資料，
 * 用中性值填進去以免影響排序」，不是一個觀察到的事實。
 * 顯示補值等於把系統的假設當成公司的數字報給人看。
 */
export function explainFactors(scores: readonly FactorScore[]): readonly ExplainedFactor[] {
  const out: ExplainedFactor[] = [];
  for (const s of scores) {
    if (s.imputed || s.rawValue === null) {
      continue;
    }
    const plain = PLAIN_FACTORS[s.factorKey];
    if (plain === undefined) {
      // 未登記白話說明的因子：顯示 factorKey 與原始值，不編造說法。
      out.push({
        factorKey: s.factorKey,
        label: s.factorKey,
        valueText: String(s.rawValue),
        betterWhen: s.direction === 'lower_is_better' ? 'lower' : 'higher',
      });
      continue;
    }
    out.push({
      factorKey: s.factorKey,
      label: plain.label,
      valueText: plain.format(s.rawValue),
      betterWhen: plain.betterWhen,
    });
  }
  return out;
}
