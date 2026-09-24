export type OrderSide = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";
export type TimeInForce = "GTT" | "IOC" | "FOK" | "ALO";

export interface ArcusCredentials {
  /// Master EVM address that owns the API key.
  address: string;
  /// Subaccount index this key is bound to. A key cannot be reused across
  /// indexes, which is why credentials travel with the slot.
  accountIndex: number;
  /// Ed25519 public key (64 hex chars) -- this *is* the API key.
  apiKey: string;
  /// Ed25519 private key: PKCS#8 PEM or 32-byte hex seed.
  secret: string;
}

export interface ArcusTradingHours {
  startSecondsOfDay: number;
  endSecondsOfDay: number;
  /// IANA zone, e.g. "America/New_York".
  timezone: string;
  isOvernight?: boolean;
}

export interface ArcusMarketInfo {
  marketId: number;
  marketDisplayName: string;
  fullAssetName?: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  /// CRYPTO | EQUITIES | COMMODITIES | INDICES
  category?: string;
  tickSize: string;
  stepSize: string;
  minOrderSize: string;
  maxOrderSize: string;
  minOrderNotional?: string;
  markPrice?: string;
  oraclePrice?: string;
  /// Fraction, e.g. "-0.0226".
  priceChange24h?: string;
  initialMarginFraction?: string;
  /// Arcus's liquidation line, e.g. "0.0267".
  maintenanceMarginFraction?: string;
  /// Higher than initialMarginFraction for markets with trading hours; Arcus
  /// applies it while `isOutsideRth` is true.
  offHoursInitialMarginFraction?: string;
  isOutsideRth?: boolean;
  /// Null for 24/7 markets.
  regularTradingHours?: ArcusTradingHours | null;
}

/// One record from `GET /v1/api-meta/markets`, keyed by ticker (the base
/// asset, "TSM") -- not the display name.
export interface ArcusMarketMeta {
  ticker: string;
  name?: string;
  logo?: string | null;
}

export interface PlaceOrderParams {
  marketId: number;
  side: OrderSide;
  orderType: OrderType;
  timeInForce: TimeInForce;
  /// Human-readable base-asset units.
  quantity: string;
  /// Human-readable USD. On a MARKET order this is the protective slippage
  /// bound and must sit within 10% of mark.
  price: string;
  reduceOnly?: boolean;
  clientId?: string;
  /// Exchange grid for this market. Required: the signed payload carries
  /// price and size as integers derived from these.
  tickSize: string;
  stepSize: string;
}

export interface PlaceOrderResult {
  orderId: string;
  clientId?: string;
  status: string;
  marketId: number;
  accountIndex: number;
  price?: string;
  quantity?: string;
}

export interface AdjustIsolatedMarginResult {
  requestId: string;
  marketId: number;
  accountIndex: number;
  /// Echoed dollar amount, decimal string.
  amount: string;
  newIsolatedMarginQuoteBalance: string;
  status: string;
  rejectReason?: string;
}

export type AccountTransferType =
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "INTERNAL_TRANSFER"
  | "SELF_ACCOUNT_TRANSFER"
  | "REFERRAL_CLAIM"
  | "LENDING_DRAW"
  | "INTEREST_SETTLEMENT"
  | "SEIZURE_PAYMENT"
  | "CLAIM_REPAYMENT";

export interface AccountTransferUpdate {
  type: AccountTransferType;
  /// Absent on stream events, which are only emitted once applied.
  status: string;
  /// REST carries `id`; stream events carry `eventId`. The stream normalises.
  id: string;
  eventId?: string;
  /// Present on WITHDRAWAL rows when Arcus echoes the submit's id.
  withdrawalId?: string;
  /// Always positive; direction is conveyed by `type`.
  amount: string;
  netQuoteBalance: string;
  globalSequenceId: number;
  /// Epoch microseconds.
  createdAt: number;
  address: string;
  accountIndex: number;
  rejectReason?: string;
  spotAssetId?: number;
}

export interface ArcusAccount {
  address: string;
  accountIndex?: number;
  netQuoteBalance: string;
  equity: string;
  freeCollateral: string;
  netDeposits: string;
}

export interface ArcusPosition {
  address: string;
  accountIndex: number;
  marketId: number;
  marketDisplayName: string;
  /// BUY/SELL on REST; LONG/SHORT (or FLAT once closed) on the stream.
  side: OrderSide | "LONG" | "SHORT" | "FLAT";
  /// Human-readable base-asset units, unsigned.
  size: string;
  averageEntryPrice: string;
  markPrice?: string;
  cumulativeFunding?: {
    allTime?: string;
    sinceOpen?: string;
    sinceChange?: string;
  };
  leverage?: string;
  marginMode?: string;
  marginUsed?: string;
  positionValueNotional?: string;
  unrealizedPnl?: string;
}

export interface ArcusFill {
  tradeId: string;
  orderId: string;
  clientId?: string;
  address?: string;
  accountIndex?: number;
  marketId: number;
  marketDisplayName: string;
  side: OrderSide;
  originalSize?: string;
  /// REST and snapshots use `size` / `price`; live channel frames may carry
  /// `fillSize` / `fillPrice` instead. The stream normalises onto size/price.
  size: string;
  price: string;
  fillSize?: string;
  fillPrice?: string;
  fee?: string;
  closedPnl?: string;
  role: string;
  remainingSize?: string;
  createdAt: number;
  liquidation?: { method?: string; liquidatedUser?: string };
}

export interface ArcusOrderUpdate {
  orderId: string;
  clientId?: string;
  marketId: number;
  accountIndex?: number;
  side: OrderSide;
  status: string;
  size?: string;
  remainingSize?: string;
  price?: string;
  cancelReason?: string;
  rejectReason?: string;
}

/// GET /v1/order/{orderId}.
export interface ArcusOrderStatus {
  orderId: string;
  clientId?: string;
  status: string;
  filledSize?: string;
  remainingSize?: string;
  avgFillPrice?: string;
  cancelReason?: string;
  rejectReason?: string;
}

export const TERMINAL_ORDER_STATUSES = new Set([
  "FILLED",
  "CANCELED",
  "CANCELLED",
  "MARGIN_CANCELED",
  "REJECTED",
  "EXPIRED",
  "LIQUIDATED",
  "ADL",
  "ERROR",
]);

/// Arcus converts dollars to quote quantums at 1e9 = $1 on the wire formats
/// that take quantums (EIP-712 transfer/withdraw messages).
export const QUOTE_QUANTUMS_PER_DOLLAR = 1_000_000_000n;

/// A position row's side is BUY/SELL on REST and LONG/SHORT on the stream.
export function isLongSide(side: string): boolean {
  return side === "BUY" || side === "LONG";
}
