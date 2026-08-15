/** P0 — 成本與損益兩平模組 public API */

export type {
  BarrierOutcome,
  BreakevenResult,
  BrokerFeeConfig,
  Money,
  PriceInput,
  RoundingMode,
  RoundTripCost,
  TradeCostInput,
  TradeOutcome,
  TradeOutcomeInput,
  TradeType,
} from './types';

export {
  CENTS_PER_TWD,
  divRound,
  mulDiv,
  parsePriceToCents,
  ratio,
  roundToWholeTwd,
  toMoney,
} from './money';

export {
  COMMISSION_RATE_CAP_PPM,
  DAY_TRADE_HALVING_END,
  DAY_TRADE_HALVING_START,
  TAX_RATE_DAY_TRADE_PPM,
  TAX_RATE_STOCK_PPM,
  assertValidBrokerConfig,
  assertValidTradeDate,
  resolveSellTaxRatePpm,
} from './fee-schedule';

export {
  calcBreakevenPrice,
  calcCommission,
  calcRoundTripCost,
  calcSecuritiesTransactionTax,
  calcTradeOutcome,
} from './cost';
