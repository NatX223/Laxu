import type { Hash } from "viem";

import type { SlotWithWallet } from "../services/allocator";
import type { ResolvedMarket } from "../services/markets";

/**
 * The venue-agnostic surface the services trade through. Every amount at this
 * boundary is in Laxu units (lib/units.ts): size6, price18, asset base units
 * as bigints. Venue units never leak past an adapter.
 */

export type OrderSide = "open_long" | "open_short" | "close_long" | "close_short";

export interface OrderOutcome {
  status: "filled" | "partial" | "unfilled" | "failed";
  requestId: bigint;
  orderId?: string;
  filledSize6: bigint;
  avgPrice18: bigint;
  feeAsset: bigint;
  /// The venue's reason codes, decoded to names.
  reason?: string;
}

/// Read ON-CHAIN (Exchange.getPosition) -- the same source the contracts use.
export interface VenuePosition {
  exists: boolean;
  direction: "long" | "short";
  size6: bigint;
  entry18: bigint;
  depositAsset: bigint;
  /// Signed.
  pnlAsset: bigint;
  /// Signed.
  premiumAsset: bigint;
  /// Margin + unrealised PnL of the position, signed (see funding.ts).
  equityAsset: bigint;
  mark18: bigint;
  markValid: boolean;
}

export interface SendHooks {
  /// Persist the transaction hash the moment it is broadcast (see chain/writes.ts).
  onSent?: (txHash: Hash) => Promise<void>;
}

export interface VenueAdapter {
  /// The account exists, forwarding is on, and the exchange is approved to pull the asset.
  ensureAccountReady(slot: SlotWithWallet): Promise<void>;
  /// Free balance in the account (not in positions), asset units.
  accountBalance(slot: SlotWithWallet): Promise<bigint>;
  /// Moves `amount` from the slot wallet into its account; credited in the same tx.
  deposit(slot: SlotWithWallet, amount: bigint, hooks?: SendHooks): Promise<Hash>;
  /// Moves `amount` from the account to the slot wallet, in the same tx.
  withdraw(slot: SlotWithWallet, amount: bigint, hooks?: SendHooks): Promise<Hash>;
  placeMarketOrder(
    slot: SlotWithWallet,
    params: {
      market: ResolvedMarket;
      side: OrderSide;
      size6: bigint;
      leverage: number;
      requestId: bigint;
      lastExecBlock: bigint;
    },
  ): Promise<OrderOutcome>;
  /// Moves `amount` of free account balance into the position's margin.
  addPositionMargin(
    slot: SlotWithWallet,
    params: { market: ResolvedMarket; amount: bigint; requestId: bigint; lastExecBlock: bigint },
  ): Promise<OrderOutcome>;
  /// The next request id for the slot's account and the `lb` to send it with.
  /// The caller saves both on its row (and raises the slot's lastRequestId
  /// with {raiseLastRequestId} in the same transaction) BEFORE sending.
  nextRequest(slot: SlotWithWallet, market: ResolvedMarket): Promise<{ requestId: bigint; lastExecBlock: bigint }>;
  /// What became of a request sent earlier: its outcome; `pending` while it may
  /// still execute (head < lb, nothing heard); `not_placed` once it can no longer.
  findOrderOutcome(
    slot: SlotWithWallet,
    requestId: bigint,
    lastExecBlock: bigint,
    options?: { market?: ResolvedMarket; kind?: "ioc" | "instant" },
  ): Promise<OrderOutcome | "pending" | "not_placed">;
  getPosition(slot: SlotWithWallet, market: ResolvedMarket): Promise<VenuePosition>;
  /// 1e18, from the API ticker. Display and sizing only; the contracts read
  /// the venue's mark on-chain themselves.
  markPrice(market: ResolvedMarket): Promise<bigint>;
}

let adapter: VenueAdapter | undefined;

/// The venue the services trade on: Perpl.
export function venue(): VenueAdapter {
  if (!adapter) {
    // Required lazily so the adapter's imports (allocator, markets) can import
    // this module's types without a load-order cycle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PerplAdapter } = require("./perpl/adapter") as typeof import("./perpl/adapter");
    adapter = new PerplAdapter();
  }
  return adapter;
}
