import type { Address } from "viem";

import { config } from "../../config/env";

/**
 * Perpl endpoints and ids, from env. Testnet defaults:
 *   REST  https://testnet.perpl.xyz/api   (paths below start at /v1/...)
 *   WS    wss://testnet.perpl.xyz         (trading socket at /ws/v1/trading)
 *   chain 10143 (Monad testnet)
 */

export function perplApiUrl(): string {
  return config.perplApiUrl.replace(/\/$/, "");
}

export function perplTradingWsUrl(): string {
  return `${config.perplWsUrl.replace(/\/$/, "")}/ws/v1/trading`;
}

export function perplChainId(): number {
  return config.perplChainId;
}

export function exchangeAddress(): Address {
  if (!config.perplExchangeAddress) throw new Error("PERPL_EXCHANGE is not configured");
  return config.perplExchangeAddress as Address;
}

/// `scope_mask` for enrollment: read | trade.
export const PERPL_SCOPE_READ_TRADE = 3;

/// Order types (`t`).
export const OrderType = {
  OpenLong: 1,
  OpenShort: 2,
  CloseLong: 3,
  CloseShort: 4,
  Cancel: 5,
  IncreasePositionCollateral: 6,
  Change: 7,
} as const;

/// Order flags (`fl`).
export const OrderFlags = { GoodTillCancel: 0, PostOnly: 1, FillOrKill: 2, ImmediateOrCancel: 4 } as const;

/// Order status (`st`).
export const OrderStatus = {
  Pending: 1,
  Open: 2,
  PartiallyFilled: 3,
  Filled: 4,
  Canceled: 5,
  Expired: 6,
  Failed: 7,
  Untriggered: 8,
  Triggered: 9,
  Executed: 10,
} as const;

/// Position status (`st` on a Position).
export const PositionStatus = { Open: 1, Closed: 2, Liquidated: 3, Deleveraged: 4, Unwound: 5, Failed: 6 } as const;

/// Position status reasons that mean the venue took the position, not us.
export const POSITION_FORCED_EXIT_REASONS = new Set([15 /* Deleveraged */, 19 /* Liquidated */, 22 /* Unwound */]);

/// WebSocket message types.
export const Mt = {
  Ping: 1,
  Pong: 2,
  StatusResponse: 3,
  WalletSnapshot: 19,
  WalletUpdate: 20,
  AccountUpdate: 21,
  OrderRequest: 22,
  OrdersSnapshot: 23,
  OrdersUpdate: 24,
  FillsUpdate: 25,
  PositionsSnapshot: 26,
  PositionsUpdate: 27,
  AccountStatsUpdate: 28,
  ApiKeySignIn: 29,
  Heartbeat: 100,
} as const;

/// `OrderStatusReason` names, for logs and failure messages.
export const ORDER_STATUS_REASONS: Record<number, string> = {
  1: "AmountExceedsAvailableBalance",
  2: "AccountFrozen",
  3: "CancelExistingInvalidCloseOrders",
  4: "CantChangeCloseOrder",
  5: "ChangeExpiredOrderNeedsNewExpiry",
  6: "ClearingExpiredOrder",
  7: "ClearingFrozenAccountOrder",
  8: "ClearingInvalidCloseOrder",
  9: "ClearingSelfMatchingOrder",
  10: "CloseOrderExceedsPosition",
  11: "CloseOrderPositionMismatch",
  12: "ContractNotOperational",
  13: "CrossesBook",
  14: "ExceedsLastExecutionBlock",
  15: "ForwardingReverted",
  16: "ImmediateOrCancelExecuted",
  17: "ImmediateOrderUnderMinimum",
  18: "InsuficientFundsForRecycleFee",
  19: "InvalidAccountFrozenOrder",
  20: "InvalidExpiryBlock",
  21: "InvalidOrderId",
  22: "MakerOrderFilled",
  23: "MakerOrderSettlementFailed",
  24: "MaximumAccountOrders",
  25: "MaxMatchesReached",
  26: "NoOp",
  27: "OrderBookFull",
  28: "OrderCancelled",
  29: "OrderCancelledByAdmin",
  30: "OrderCancelledByLiquidator",
  31: "OrderChanged",
  32: "OrderDescIdTooLow",
  33: "OrderDoesNotExist",
  34: "OrderForwardingNotAllowed",
  35: "OrderPlaced",
  36: "OrderPostFailed",
  37: "OrderSettlementImpliesInsolvent",
  38: "OrderSizeExceedsAvailableSize",
  39: "PostOrderUnderMinimum",
  40: "PriceOutOfRange",
  41: "RecycleBalanceInsufficientSevere",
  42: "SizeOutOfRange",
  43: "TakerOrderFilled",
  44: "TakerOrderSettlementFailed",
  45: "UnableToCancelOrder",
  46: "UnmatchedLotRemainsInFillOrKill",
  47: "UnspecifiedCollateral",
  48: "UnspecifiedPrice",
  49: "UnspecifiedSize",
  50: "WrongAccountForOrder",
  51: "WrongChainForOrder",
  52: "WrongMarketForOrder",
  53: "PerpetualInsolvent",
  54: "Triggered",
  55: "InvalidAmount",
  56: "InvalidFlags",
  57: "InvalidTriggerOrder",
  58: "WrongTriggerPosition",
  59: "TriggerDescIdTooLow",
  60: "TriggerOrderRequest",
  61: "ValueExceedsMaximum",
  62: "ClearingRemainingOrderLockBeyondBalance",
  63: "PriceSetDuringTriggerExec",
  64: "TriggeredExecutionAttemptsExhausted",
  65: "TriggeredOrderExecuted",
  66: "TriggeredOrderPartiallyFilled",
  67: "TriggeredOrderExpired",
  68: "TriggeredOrderRecoverableFailure",
  69: "OrderExtensionRejected",
};

/// `OrderFailureReason` names (`fr`).
export const ORDER_FAILURE_REASONS: Record<number, string> = {
  1: "InsufficientBalance",
  2: "InsufficientCollateralIncrease",
  3: "InsufficientCollateralInvert",
  4: "NoPositionToClose",
  5: "PerpetualSolvency",
  6: "NegativePositionValue",
  7: "ReferencePriceStale",
  8: "ExceedsMaxNegPnlCollat",
  9: "Other",
};

export function describeOrderReason(sr?: number, fr?: number): string | undefined {
  const parts: string[] = [];
  if (sr) parts.push(ORDER_STATUS_REASONS[sr] ?? `sr ${sr}`);
  if (fr) parts.push(ORDER_FAILURE_REASONS[fr] ?? `fr ${fr}`);
  return parts.length > 0 ? parts.join(" / ") : undefined;
}
