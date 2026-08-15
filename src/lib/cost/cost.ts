/**
 * P0 — 成本與損益兩平核心計算。純函式，無副作用，無外部依賴。
 */

import {
  CENTS_PER_TWD,
  mulDiv,
  parsePriceToCents,
  ratio,
  toMoney,
} from './money';
import {
  BPS_DIVISOR,
  PPM_DIVISOR,
  assertValidBrokerConfig,
  resolveSellTaxRatePpm,
} from './fee-schedule';
import type {
  BarrierOutcome,
  BreakevenResult,
  BrokerFeeConfig,
  Money,
  PriceInput,
  RoundTripCost,
  TradeCostInput,
  TradeOutcome,
  TradeOutcomeInput,
  TradeType,
} from './types';

/** 損益兩平搜尋上限：自進場價起算 1,000,000 分（= 10,000 元）漲幅。 */
const MAX_BREAKEVEN_SCAN_CENTS = 1_000_000n;

function assertShares(shares: number): void {
  if (!Number.isSafeInteger(shares) || shares <= 0) {
    throw new RangeError(`shares must be a positive integer, got ${String(shares)}`);
  }
}

function assertPositivePrice(cents: bigint, name: string): void {
  if (cents <= 0n) {
    throw new RangeError(`${name} must be greater than 0`);
  }
}

function effectiveDiscountBps(broker: BrokerFeeConfig, tradeType: TradeType): number {
  if (tradeType === 'day_trade' && broker.dayTradeDiscountBps !== undefined) {
    return broker.dayTradeDiscountBps;
  }
  return broker.discountBps;
}

/**
 * 手續費（元）。一次算到「元」，中途不重複捨入。
 * 公式：成交金額 × 費率(ppm) × 折讓(bps) ÷ (1e6 × 1e4)，再依 mode 捨入到元，
 *       最後與最低手續費取大。
 */
function commissionTwd(
  amountCents: bigint,
  broker: BrokerFeeConfig,
  tradeType: TradeType,
): { readonly twd: bigint; readonly hitFloor: boolean } {
  const discountBps = effectiveDiscountBps(broker, tradeType);
  const computed = mulDiv(
    amountCents,
    BigInt(broker.commissionRatePpm) * BigInt(discountBps),
    PPM_DIVISOR * BPS_DIVISOR * CENTS_PER_TWD,
    broker.commissionRounding,
  );
  const minTwd = BigInt(broker.minCommissionTwd);
  const hitFloor = computed < minTwd;
  return { twd: hitFloor ? minTwd : computed, hitFloor };
}

/** 證券交易稅（元）。僅賣出課徵。 */
function taxTwd(amountCents: bigint, ratePpm: number, broker: BrokerFeeConfig): bigint {
  return mulDiv(
    amountCents,
    BigInt(ratePpm),
    PPM_DIVISOR * CENTS_PER_TWD,
    broker.taxRounding,
  );
}

/** 一次驗證 + 一次解析，供 breakeven 掃描重複使用，避免重複 parse。 */
interface CostContext {
  readonly entryCents: bigint;
  readonly shares: bigint;
  readonly tradeType: TradeType;
  readonly broker: BrokerFeeConfig;
  readonly taxRatePpm: number;
  readonly taxWarnings: readonly string[];
  readonly buyAmountCents: bigint;
  readonly buyCommissionTwd: bigint;
  readonly buyCommissionHitFloor: boolean;
}

function createContext(input: TradeCostInput): CostContext {
  assertValidBrokerConfig(input.broker);
  assertShares(input.shares);

  const entryCents = parsePriceToCents(input.entryPrice);
  assertPositivePrice(entryCents, 'entryPrice');

  const shares = BigInt(input.shares);
  const buyAmountCents = entryCents * shares;
  const buy = commissionTwd(buyAmountCents, input.broker, input.tradeType);
  const tax = resolveSellTaxRatePpm(input.tradeType, input.tradeDate);

  return {
    entryCents,
    shares,
    tradeType: input.tradeType,
    broker: input.broker,
    taxRatePpm: tax.ratePpm,
    taxWarnings: tax.warnings,
    buyAmountCents,
    buyCommissionTwd: buy.twd,
    buyCommissionHitFloor: buy.hitFloor,
  };
}

function roundTripAt(ctx: CostContext, exitCents: bigint): RoundTripCost {
  const sellAmountCents = exitCents * ctx.shares;
  const sell = commissionTwd(sellAmountCents, ctx.broker, ctx.tradeType);
  const tax = taxTwd(sellAmountCents, ctx.taxRatePpm, ctx.broker);

  const totalCostCents = (ctx.buyCommissionTwd + sell.twd + tax) * CENTS_PER_TWD;
  const grossPnlCents = sellAmountCents - ctx.buyAmountCents;
  const netPnlCents = grossPnlCents - totalCostCents;

  return {
    buyAmount: toMoney(ctx.buyAmountCents),
    sellAmount: toMoney(sellAmountCents),
    buyCommission: toMoney(ctx.buyCommissionTwd * CENTS_PER_TWD),
    sellCommission: toMoney(sell.twd * CENTS_PER_TWD),
    buyCommissionHitFloor: ctx.buyCommissionHitFloor,
    sellCommissionHitFloor: sell.hitFloor,
    tax: toMoney(tax * CENTS_PER_TWD),
    taxRatePpm: ctx.taxRatePpm,
    totalCost: toMoney(totalCostCents),
    grossPnl: toMoney(grossPnlCents),
    netPnl: toMoney(netPnlCents),
    costRatioBps: Number(mulDiv(totalCostCents, 10_000n, ctx.buyAmountCents, 'half_up')),
    warnings: ctx.taxWarnings,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/** 單邊手續費（買或賣皆適用，公式相同） */
export function calcCommission(
  price: PriceInput,
  shares: number,
  broker: BrokerFeeConfig,
  tradeType: TradeType,
): { readonly fee: Money; readonly hitFloor: boolean } {
  assertValidBrokerConfig(broker);
  assertShares(shares);
  const priceCents = parsePriceToCents(price);
  assertPositivePrice(priceCents, 'price');

  const result = commissionTwd(priceCents * BigInt(shares), broker, tradeType);
  return { fee: toMoney(result.twd * CENTS_PER_TWD), hitFloor: result.hitFloor };
}

/** 證券交易稅（僅賣出課徵） */
export function calcSecuritiesTransactionTax(
  price: PriceInput,
  shares: number,
  tradeType: TradeType,
  tradeDate: string,
  broker: BrokerFeeConfig,
): { readonly tax: Money; readonly ratePpm: number; readonly warnings: readonly string[] } {
  assertValidBrokerConfig(broker);
  assertShares(shares);
  const priceCents = parsePriceToCents(price);
  assertPositivePrice(priceCents, 'price');

  const resolved = resolveSellTaxRatePpm(tradeType, tradeDate);
  const amountCents = priceCents * BigInt(shares);
  return {
    tax: toMoney(taxTwd(amountCents, resolved.ratePpm, broker) * CENTS_PER_TWD),
    ratePpm: resolved.ratePpm,
    warnings: resolved.warnings,
  };
}

/** 一買一賣完整成本與損益 */
export function calcRoundTripCost(
  input: TradeCostInput & { readonly exitPrice: PriceInput },
): RoundTripCost {
  const ctx = createContext(input);
  const exitCents = parsePriceToCents(input.exitPrice);
  assertPositivePrice(exitCents, 'exitPrice');
  return roundTripAt(ctx, exitCents);
}

/**
 * 損益兩平價：使淨損益 ≥ 0 的**最低**賣出價。
 *
 * 為何用線性掃描而非解析解或二分搜尋：
 * 最低手續費與「元以下」捨入使成本成為階梯函數。當股數少時，價格 +1 分帶來的
 * 收入（= 股數分）可能小於手續費／稅的一次跳階（各最多 100 分），淨損益對賣價
 * **並非嚴格單調**，二分搜尋無法保證取到最小值。實際掃描範圍僅數十分（成本約
 * 0.45%），線性掃描既正確又足夠快。
 */
export function calcBreakevenPrice(input: TradeCostInput): BreakevenResult {
  const ctx = createContext(input);

  for (let step = 0n; step <= MAX_BREAKEVEN_SCAN_CENTS; step += 1n) {
    const exitCents = ctx.entryCents + step;
    const cost = roundTripAt(ctx, exitCents);
    if (cost.netPnl.cents >= 0n) {
      return {
        breakevenPrice: toMoney(exitCents),
        breakevenMoveBps: Number(mulDiv(step, 10_000n, ctx.entryCents, 'half_up')),
        costAtBreakeven: cost,
        tickAligned: false,
      };
    }
  }

  throw new RangeError(
    `breakeven price not found within ${MAX_BREAKEVEN_SCAN_CENTS.toString()} cents above entry`,
  );
}

function buildBarrier(
  exitCents: bigint,
  cost: RoundTripCost,
  nominalRiskCents: bigint,
  netRiskCents: bigint,
): BarrierOutcome {
  return {
    exitPrice: toMoney(exitCents),
    cost,
    netPnl: cost.netPnl,
    rMultiple: ratio(cost.netPnl.cents, nominalRiskCents),
    rMultipleVsNetRisk: ratio(cost.netPnl.cents, netRiskCents),
  };
}

/** 停損／停利兩道屏障下的淨損益與實際 R 倍數 */
export function calcTradeOutcome(input: TradeOutcomeInput): TradeOutcome {
  const ctx = createContext(input);

  const stopCents = parsePriceToCents(input.stopLossPrice);
  const takeProfitCents = parsePriceToCents(input.takeProfitPrice);
  assertPositivePrice(stopCents, 'stopLossPrice');
  assertPositivePrice(takeProfitCents, 'takeProfitPrice');

  if (stopCents >= ctx.entryCents) {
    throw new RangeError('stopLossPrice must be lower than entryPrice');
  }
  if (takeProfitCents <= ctx.entryCents) {
    throw new RangeError('takeProfitPrice must be higher than entryPrice');
  }

  const nominalRiskCents = (ctx.entryCents - stopCents) * ctx.shares;
  const stopCost = roundTripAt(ctx, stopCents);
  const netRiskCents = -stopCost.netPnl.cents;
  const takeProfitCost = roundTripAt(ctx, takeProfitCents);

  const stopLoss = buildBarrier(stopCents, stopCost, nominalRiskCents, netRiskCents);
  const takeProfit = buildBarrier(
    takeProfitCents,
    takeProfitCost,
    nominalRiskCents,
    netRiskCents,
  );

  const warnings: string[] = [...ctx.taxWarnings];
  if (takeProfit.rMultiple < 2) {
    warnings.push(
      `停利淨 R = ${takeProfit.rMultiple.toFixed(4)} < 2R。CLAUDE.md 要求停利 ≥2R，` +
        '扣除交易成本後未達門檻，應提高停利價或放大部位金額。',
    );
  }

  return {
    breakeven: calcBreakevenPrice(input),
    nominalRisk: toMoney(nominalRiskCents),
    netRisk: toMoney(netRiskCents),
    stopLoss,
    takeProfit,
    warnings,
  };
}
