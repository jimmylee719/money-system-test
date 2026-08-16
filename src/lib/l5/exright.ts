/**
 * 除權息事件的正規化與報酬還原。純函式。
 *
 * 【為什麼一定要還原】（CLAUDE.md）
 * 除權息當天股價會直接扣掉股利，那不是下跌。台股除權息集中在 7–9 月，
 * 不還原就會系統性低估整個旺季的報酬，直接影響 G2（期望值、獲利因子）
 * 與 G3（勝過 0050）的判定——而 0050 的對照通常是含息報酬，
 * 拿不含息的個股報酬去比，等於一開始就認輸。
 *
 * 【單位以官方參考價反推驗證過】（2026-08-16）
 * 兩個交易所的**預告表**單位一致：
 *   StockDividendRatio = 每股配股率（0.0499 = 每股配 0.0499 股）
 *   CashDividend       = 現金股利（元／股）
 * 但上櫃**計算結果表**的 `StockDividend` 是**權值（元）**不是比率——
 * 誤用會讓 4123 晟德的參考價從 31.01 算成 12.78。
 * 驗證：(34.30 − 1.74669) ÷ (1 + 0.0499055) = 31.0059，官方 31.01 ✓
 *
 * 【明確假設：不參與現金增資認股】
 * 交易所的參考價公式含認股項，因為它假設股東會認購。
 * 本系統是被動持有，不認購，因此**現金增資不做還原**——
 * 沒認購的人確實會被稀釋，那個下跌是真實的損失，不該被還原掉。
 * 但會標記 `hasRightsIssue`，讓 P12 決定要不要排除這些觀察值。
 */

import { rocDateToIso } from '../l0/roc-date';
import type { L1Market } from '../l1/types';

/** 一次除權息事件 */
export interface ExRightEvent {
  readonly code: string;
  readonly market: L1Market;
  /** 除權息交易日（ISO）。當日開盤價已扣除股利。 */
  readonly exDate: string;
  /** 現金股利（元／股） */
  readonly cashDividend: number;
  /** 無償配股率（每股配幾股）。0.1 = 每 1000 股配 100 股。 */
  readonly stockDividendRatio: number;
  /** 是否含現金增資認股（本系統不認購，故不還原，但要標記） */
  readonly hasRightsIssue: boolean;
  /** 官方原文：息／權／權息 */
  readonly kind: string;
}

type RawRow = Record<string, unknown>;

function num(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value !== 'string') {
    return 0;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return 0;
  }
  const parsed = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRows(payload: unknown): readonly RawRow[] {
  return Array.isArray(payload) ? (payload as RawRow[]) : [];
}

/**
 * 上市除權除息預告表（TWT48U_ALL）。
 *
 * ⚠️ 這是**預告**表：只列出即將到來的除權息，過去的會消失。
 *    因此必須每日抓取，用各日快照的**聯集**才涵蓋所有事件。
 *    快照的 data_as_of 是 payload 內最遠的除權息日（依宣告的 max 規則），
 *    **不是**「這份資料描述哪一天」——逐列的 Date 才是各自的除權息日。
 */
export function normalizeTwseExRight(payload: unknown): readonly ExRightEvent[] {
  const events: ExRightEvent[] = [];
  for (const r of asRows(payload)) {
    const code = text(r['Code']);
    const exDate = rocDateToIso(text(r['Date']));
    if (code === '' || exDate === null) {
      continue;
    }
    events.push({
      code,
      market: 'TWSE',
      exDate,
      cashDividend: num(r['CashDividend']),
      stockDividendRatio: num(r['StockDividendRatio']),
      hasRightsIssue: num(r['SubscriptionRatio']) > 0,
      kind: text(r['Exdividend']), // 官方拼法：小寫 d
    });
  }
  return events;
}

/** 上櫃除權除息預告表（tpex_exright_prepost）。單位與上市相同。 */
export function normalizeTpexExRight(payload: unknown): readonly ExRightEvent[] {
  const events: ExRightEvent[] = [];
  for (const r of asRows(payload)) {
    const code = text(r['SecuritiesCompanyCode']);
    // 官方欄位名 ExRrightsExDividendDate（Rrights 兩個 r）
    const exDate = rocDateToIso(text(r['ExRrightsExDividendDate']));
    if (code === '' || exDate === null) {
      continue;
    }
    events.push({
      code,
      market: 'TPEx',
      exDate,
      cashDividend: num(r['CashDividend']),
      stockDividendRatio: num(r['StockDividendRatio']),
      hasRightsIssue: num(r['SubscriptionRatioToNewSharesIssued']) > 0,
      kind: text(r['ExRrightsExDividend']),
    });
  }
  return events;
}

/**
 * 上櫃除權息計算結果表（tpex_exright_daily）——**交叉驗證用**。
 *
 * ⚠️ 此表的 `StockDividend` 是**權值（元）**，不是配股率。
 *    配股率要用 `StockDivdendThousandShares`（官方拼法 Divdend）÷ 1000。
 */
export interface ExRightCheckRow {
  readonly code: string;
  readonly exDate: string;
  readonly closeBefore: number;
  /** 交易所公告的除權息參考價 */
  readonly officialReferencePrice: number;
  readonly cashDividend: number;
  readonly stockDividendRatio: number;
}

export function normalizeTpexExRightCheck(payload: unknown): readonly ExRightCheckRow[] {
  const rows: ExRightCheckRow[] = [];
  for (const r of asRows(payload)) {
    const code = text(r['SecuritiesCompanyCode']);
    const exDate = rocDateToIso(text(r['Date']));
    if (code === '' || exDate === null) {
      continue;
    }
    rows.push({
      code,
      exDate,
      closeBefore: num(r['ClosePriceBeforeExRightsDiviend']),
      officialReferencePrice: num(r['ExRightsDiviendQuote']),
      // 高精度欄位（官方拼法 CashDivdend）
      cashDividend: num(r['CashDivdend']),
      stockDividendRatio: num(r['StockDivdendThousandShares']) / 1000,
    });
  }
  return rows;
}

/**
 * 交易所的除權息參考價公式（不含現金增資項）：
 *   參考價 =（前一日收盤 − 現金股利）÷（1 + 無償配股率）
 *
 * 提供這個函式是為了**對官方公告的參考價做交叉驗證**——
 * 若我們算的和交易所公告的對不上，代表欄位單位理解錯了。
 */
export function referencePrice(
  closeBefore: number,
  cashDividend: number,
  stockDividendRatio: number,
): number {
  return (closeBefore - cashDividend) / (1 + stockDividendRatio);
}

// ── 持有期間的還原 ───────────────────────────────────────────────────────────

export interface HoldingAdjustment {
  /** 每 1 股原始持股，期末變成幾股 = Π(1 + Sᵢ) */
  readonly shareFactor: number;
  /** 每 1 股原始持股，期間共領到多少現金股利 */
  readonly cashPerOriginalShare: number;
  /** 期間內發生的事件，依除權息日升冪 */
  readonly events: readonly ExRightEvent[];
  /** 期間內是否有現金增資（本系統不認購，故不還原，但要標記） */
  readonly hasRightsIssue: boolean;
}

export const NO_ADJUSTMENT: HoldingAdjustment = {
  shareFactor: 1,
  cashPerOriginalShare: 0,
  events: [],
  hasRightsIssue: false,
};

/**
 * 計算 `(afterDate, throughDate]` 這段持有期間的還原係數。
 *
 * 【區間為左開右閉，這很重要】
 * 進場日當天的收盤價**已經**是除權息後的價格（若當日除權息），
 * 所以進場日的事件不該再還原一次。出場日當天的事件則要算進去，
 * 因為出場價已被扣除，必須補回來。
 *
 * 【多次除權息時，後面的現金股利適用已增加的股數】
 * 第 i 次的現金股利要乘上「第 i 次之前累積的股數」，不是乘 1。
 */
export function adjustmentFor(
  events: readonly ExRightEvent[],
  afterDate: string,
  throughDate: string,
): HoldingAdjustment {
  const inWindow = events
    .filter((e) => e.exDate > afterDate && e.exDate <= throughDate)
    .sort((a, b) => a.exDate.localeCompare(b.exDate));

  let shareFactor = 1;
  let cash = 0;
  for (const event of inWindow) {
    // 現金股利依「這次除權息之前」持有的股數計算
    cash += event.cashDividend * shareFactor;
    shareFactor *= 1 + event.stockDividendRatio;
  }

  return {
    shareFactor,
    cashPerOriginalShare: cash,
    events: inWindow,
    hasRightsIssue: inWindow.some((e) => e.hasRightsIssue),
  };
}

/**
 * 含息總報酬。
 *
 *   報酬 =（出場價 × 股數係數 + 現金股利）÷ 進場價 − 1
 *
 * 不含息的原始報酬（未還原）請用 `rawReturn`，兩者都會寫進 outcomes，
 * 差額本身就是「除權息造成的低估幅度」，可直接稽核。
 */
export function totalReturn(
  entryPrice: number,
  exitPrice: number,
  adjustment: HoldingAdjustment,
): number {
  if (entryPrice <= 0) {
    throw new RangeError('進場價必須為正數');
  }
  return (exitPrice * adjustment.shareFactor + adjustment.cashPerOriginalShare) / entryPrice - 1;
}

export function rawReturn(entryPrice: number, exitPrice: number): number {
  if (entryPrice <= 0) {
    throw new RangeError('進場價必須為正數');
  }
  return exitPrice / entryPrice - 1;
}

/** 依代號分組，方便逐檔查詢 */
export function groupByCode(
  events: readonly ExRightEvent[],
): ReadonlyMap<string, readonly ExRightEvent[]> {
  const map = new Map<string, ExRightEvent[]>();
  for (const event of events) {
    const list = map.get(event.code);
    if (list === undefined) {
      map.set(event.code, [event]);
    } else {
      list.push(event);
    }
  }
  return map;
}

/**
 * 合併多份快照的除權息事件並去重。
 *
 * 預告表是滾動的，每日快照互有重疊；同一事件會出現在很多份快照裡。
 * 以 (code, exDate) 為鍵去重，**保留最後出現的版本**——
 * 公司可能更正股利金額，越晚的快照越接近最終值。
 */
export function mergeEvents(
  batches: readonly (readonly ExRightEvent[])[],
): readonly ExRightEvent[] {
  const byKey = new Map<string, ExRightEvent>();
  for (const batch of batches) {
    for (const event of batch) {
      byKey.set(`${event.code}|${event.exDate}`, event);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.exDate.localeCompare(b.exDate) || a.code.localeCompare(b.code),
  );
}
