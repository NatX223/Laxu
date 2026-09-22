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

export interface ArcusMarketInfo {
  marketId: number;
  marketDisplayName: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: string;
  stepSize: string;
  minOrderSize: string;
  maxOrderSize: string;
  minOrderNotional?: string;
  markPrice?: string;
  oraclePrice?: string;
  maxLeverage?: string | number;
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
  status: string;
  id: string;
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
  side: OrderSide;
  /// Human-readable base-asset units, unsigned.
  size: string;
  averageEntryPrice: string;
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
  originalSize: string;
  size: string;
  price: string;
  fee: string;
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

export const TERMINAL_ORDER_STATUSES = new Set(["FILLED", "CANCELED", "CANCELLED", "REJECTED", "EXPIRED"]);

/// Arcus converts dollars to quote quantums at 1e9 = $1 on the wire formats
/// that take quantums (EIP-712 transfer/withdraw messages).
export const QUOTE_QUANTUMS_PER_DOLLAR = 1_000_000_000n;
