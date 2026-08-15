/**
 * P0 — 成本與損益兩平模組：型別定義
 *
 * 設計原則：
 * - 金額一律以「分」(cent = 1/100 元) 的 bigint 表示，不使用浮點數。
 * - 所有 interface 皆 readonly，模組內全為純函式、無副作用。
 */

/** 價格輸入（單位：元）。string 最安全（"12.35"）；number 需 ≤2 位小數且非指數表示法。 */
export type PriceInput = number | string;

/** 金額。`cents` 是唯一真值來源；`twd` 僅供顯示，永不參與計算。 */
export interface Money {
  readonly cents: bigint;
  readonly twd: string;
}

/**
 * 交易類型
 * - `normal`：一般買賣，賣出課證交稅 3‰
 * - `day_trade`：現股當沖，賣出課證交稅 1.5‰
 *   ⚠️ CLAUDE.md 禁止當沖。本模式僅供成本比較，任何路徑都會回傳 warning。
 */
export type TradeType = 'normal' | 'day_trade';

/**
 * 捨入模式（用於「元以下」處理）
 * - `floor`：無條件捨去（多數券商實務）
 * - `ceil`：無條件進位
 * - `half_up`：四捨五入（.5 遠離零）
 */
export type RoundingMode = 'floor' | 'ceil' | 'half_up';

/**
 * 券商費用設定。**全部必填**——這些沒有一項是法規固定值。
 * 手續費 1.425‰ 是法規「上限」，實際費率與折讓由券商自訂；
 * 最低手續費與元以下捨入方式查無法規依據，屬券商商業條件。
 */
export interface BrokerFeeConfig {
  /** 手續費基準費率，單位 ppm（百萬分之一）。法定上限 1425 ppm = 0.1425%。 */
  readonly commissionRatePpm: number;
  /** 折讓率，單位 bps（萬分之一）。10000 = 無折讓；6000 = 6 折；2800 = 2.8 折。 */
  readonly discountBps: number;
  /** 單筆最低手續費（元）。查無法規依據，由券商自訂，常見 20。 */
  readonly minCommissionTwd: number;
  /** 手續費元以下捨入方式。查無統一法規，多數券商為 floor。 */
  readonly commissionRounding: RoundingMode;
  /** 證交稅元以下捨入方式。查無統一法規，實務多為 floor。 */
  readonly taxRounding: RoundingMode;
  /** 選配：當沖另有折讓時覆寫 `discountBps`。 */
  readonly dayTradeDiscountBps?: number;
}

/** 成本計算輸入 */
export interface TradeCostInput {
  /** 進場價（元／股） */
  readonly entryPrice: PriceInput;
  /** 股數，正整數 */
  readonly shares: number;
  readonly tradeType: TradeType;
  readonly broker: BrokerFeeConfig;
  /** 交易日 'YYYY-MM-DD'。必填——稅率隨法規施行期間變動，不可用「今天」推定。 */
  readonly tradeDate: string;
}

/** 三屏障損益計算輸入 */
export interface TradeOutcomeInput extends TradeCostInput {
  /** 停損價（必須 < entryPrice） */
  readonly stopLossPrice: PriceInput;
  /** 停利價（必須 > entryPrice） */
  readonly takeProfitPrice: PriceInput;
}

/** 一買一賣（round trip）的完整成本與損益 */
export interface RoundTripCost {
  /** 進場成交金額 = 進場價 × 股數 */
  readonly buyAmount: Money;
  /** 出場成交金額 = 出場價 × 股數 */
  readonly sellAmount: Money;
  readonly buyCommission: Money;
  readonly sellCommission: Money;
  /** 買進手續費是否被最低手續費撐起 */
  readonly buyCommissionHitFloor: boolean;
  /** 賣出手續費是否被最低手續費撐起 */
  readonly sellCommissionHitFloor: boolean;
  /** 證券交易稅（僅賣出課徵） */
  readonly tax: Money;
  /** 實際採用的稅率 ppm，供稽核比對 */
  readonly taxRatePpm: number;
  /** 總成本 = 買進手續費 + 賣出手續費 + 證交稅 */
  readonly totalCost: Money;
  /** 毛損益 = 出場金額 − 進場金額（未扣成本） */
  readonly grossPnl: Money;
  /** 淨損益 = 毛損益 − 總成本 */
  readonly netPnl: Money;
  /** 總成本 ÷ 進場金額，單位 bps（萬分之一） */
  readonly costRatioBps: number;
  readonly warnings: readonly string[];
}

/** 損益兩平計算結果 */
export interface BreakevenResult {
  /** 使淨損益 ≥ 0 的**最低**賣出價（元／股） */
  readonly breakevenPrice: Money;
  /** 相對進場價需上漲的幅度，單位 bps */
  readonly breakevenMoveBps: number;
  readonly costAtBreakeven: RoundTripCost;
  /** ⚠️ 未對齊台股升降單位（tick size）。P0 不處理，留待後續 phase。 */
  readonly tickAligned: false;
}

/** 單一屏障（停損或停利）觸發時的結果 */
export interface BarrierOutcome {
  readonly exitPrice: Money;
  readonly cost: RoundTripCost;
  readonly netPnl: Money;
  /**
   * 主指標：淨損益 ÷ 名目風險。
   * 名目風險 = (進場價 − 停損價) × 股數，與 CLAUDE.md 部位公式同分母。
   */
  readonly rMultiple: number;
  /** 對照用：淨損益 ÷ 淨風險（停損觸發時的實際淨虧損） */
  readonly rMultipleVsNetRisk: number;
}

/** 三屏障完整結果 */
export interface TradeOutcome {
  readonly breakeven: BreakevenResult;
  /** 名目 1R = (進場價 − 停損價) × 股數 */
  readonly nominalRisk: Money;
  /** 淨 1R = 停損觸發時的實際淨虧損絕對值（已含來回成本） */
  readonly netRisk: Money;
  readonly stopLoss: BarrierOutcome;
  readonly takeProfit: BarrierOutcome;
  readonly warnings: readonly string[];
}
