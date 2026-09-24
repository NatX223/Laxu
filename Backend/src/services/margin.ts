import type { LedgerEntry, Position } from "@prisma/client";
import { parseAbiItem, type Address } from "viem";

import { adjustIsolatedMargin } from "../arcus/client";
import { isLongSide, type OrderSide } from "../arcus/types";
import { db } from "../config/db";
import { publicClient } from "../chain/clients";
import {
  fulfillDepositRequest,
  fulfillRedeemRequest,
  isNoPendingRevert,
  navPerShare,
  pendingDeposit,
  pendingRedeem,
  readPositionState,
  totalPendingDepositAssets,
  transferUsdg,
  usdgBalanceOf,
} from "../chain/writes";
import { alert, createLogger, errorFields } from "../lib/logger";
import { PRICE_SCALE, fromPrice18, fromSize6, fromUsdg6, toPrice18, toSize6 } from "../lib/units";
import { credentialsFor, getSlotForPosition, type SlotWithWallet } from "./allocator";
import { ensureInternalWalletFloat, fundSubaccount, walletForSlot } from "./arcusFunding";
import { awaitWithdrawalApplied, withdrawable6, withdrawToInternalWallet } from "./arcusWithdraw";
import {
  findEntryForLog,
  markCancelled,
  markConfirmed,
  markOnchainFulfilled,
  recordPending,
  type LedgerType,
} from "./ledger";
import { requireMarket, type ResolvedMarket } from "./markets";
import { clientIdFor, placeMarketOrder } from "./orders";
import { findLeg, pushFreshReport } from "./reporter";
import { buyInAddedSize, marginUsed6, redeemClosedSize } from "./sizing";

const log = createLogger("margin");

/**
 * Buy-ins and redeems on a live position.
 *
 * The rule: a buy-in or redeem changes how BIG the position is, never how
 * LEVERAGED. Every share always represents the same slice of the same trade.
 *
 *   buy-in of `a` USDG   -> the Arcus position grows by ΔS = a x S / V
 *   redeem of `s` shares -> it shrinks by f = s / supply; the redeemer gets f x V
 *
 * The on-chain vault locks the funds first (requestDeposit / requestRedeem);
 * the Arcus leg moves; then the fulfil settles in one transaction, priced by
 * the contract itself at navPerShare(). Buyers pay exactly NAV and redeemers
 * receive exactly NAV, so NAV per share is continuous through both.
 *
 * The Arcus leg can succeed while the fulfil fails: the user may have cancelled
 * after the 20-minute timeout, so the fulfil reverts "no pending ..." and the
 * Arcus move is undone. That is a cancellation, not an error -- never retried.
 *
 * Every step records what it learned on the ledger row (`pending` before the
 * first Arcus call, the fill on `confirmed`), so the reconciler can finish a
 * fulfil after a restart with the real fill.
 *
 * Testnet simplifications (USDG has an open mint):
 *   - A buyer's USDG stays inside the PositionToken as the payout buffer for
 *     future redeems. The Arcus side is funded by the slot's internal wallet.
 *   - A redeem payout the token cannot cover is topped up from the internal
 *     wallet; freed margin is withdrawn back to it afterwards (off the
 *     critical path) to refill the float.
 */

type Direction = "add" | "remove";

export interface RequestEvent {
  positionId: string;
  positionTokenAddress: string;
  /// `assets` for a deposit, `shares` for a redeem. USDG base units / shares.
  amount: bigint;
  controller: string;
  /// Always "0" on PositionToken -- kept for the record, never for dedupe.
  requestId: string;
  /// The emitting log -- what actually tells requests apart.
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
}

export async function handleDepositRequested(event: RequestEvent): Promise<void> {
  await handleMarginRequest("add", event);
}

export async function handleRedeemRequested(event: RequestEvent): Promise<void> {
  await handleMarginRequest("remove", event);
}

const typeFor = (direction: Direction): LedgerType => (direction === "add" ? "margin_add" : "margin_remove");

interface Context {
  position: Position;
  positionToken: Address;
  slot: SlotWithWallet;
  market: ResolvedMarket;
  /// The position's own side on Arcus.
  side: OrderSide;
}

async function contextFor(positionId: string): Promise<Context | null> {
  const position = await db.position.findUnique({ where: { id: positionId } });
  if (!position || position.status !== "open" || !position.positionTokenAddress) {
    log.warn("margin request for a position that is not open", { positionId, status: position?.status });
    return null;
  }
  const slot = await getSlotForPosition(positionId);
  if (!slot) throw new Error(`Position ${positionId} has no allocated slot`);
  return {
    position,
    positionToken: position.positionTokenAddress as Address,
    slot,
    market: await requireMarket(position.market),
    side: position.direction === "long" ? "BUY" : "SELL",
  };
}

async function handleMarginRequest(direction: Direction, event: RequestEvent): Promise<void> {
  // Indexer replays are normal after a restart; one ledger row per emitting
  // log keeps a re-read of the same block from double-moving anything.
  const existing = await findEntryForLog(event.txHash, event.logIndex);
  if (existing) {
    log.debug("margin request already recorded", { entryId: existing.id, status: existing.arcusStatus });
    if (existing.arcusStatus === "confirmed" && !existing.onchainFulfilledAt) {
      await completeOnChain(direction, event, existing.id);
    }
    return;
  }

  const ctx = await contextFor(event.positionId);
  if (!ctx) return;

  // `pending` before the first Arcus call, always. A redeem's USDG value is
  // settled by the contract at fulfil; this is the estimate at request time.
  const valued =
    direction === "add" ? event.amount : (event.amount * (await navPerShare(ctx.positionToken))) / PRICE_SCALE;
  const entry = await recordPending({
    positionId: event.positionId,
    type: typeFor(direction),
    amount: valued.toString(),
    requestAmount: event.amount.toString(),
    onchainRequestId: event.requestId,
    controller: event.controller,
    txHash: event.txHash,
    logIndex: event.logIndex,
    note: `on-chain ${direction === "add" ? "requestDeposit" : "requestRedeem"} ${event.txHash}#${event.logIndex}`,
  });

  if (direction === "add") await runBuyIn(ctx, entry, event.amount);
  else await runRedeem(ctx, entry, event.amount);

  await completeOnChain(direction, event, entry.id);
}

// ---------------------------------------------------------------------------
// Buy-in (Arcus spec §5 deposit leg, replaced)
// ---------------------------------------------------------------------------

async function runBuyIn(ctx: Context, entry: LedgerEntry, assets6: bigint): Promise<void> {
  const credentials = credentialsFor(ctx.slot);

  // 1. Fresh report, so navPerShare() is current when the fulfil prices shares.
  const { mark18 } = await pushFreshReport({ positionToken: ctx.positionToken, credentials, market: ctx.market });

  // 2. Size the add: the buyer's proportional share, rounded down to the step,
  //    capped so the order never needs more margin than the buy-in brought.
  const state = await readPositionState(ctx.positionToken);
  const addedSize6 = buyInAddedSize({
    assets6,
    size6: state.size,
    totalAssets6: state.totalAssets,
    leverage: ctx.position.leverage,
    mark18,
    grid: ctx.market,
  });

  // 3. Fund the subaccount (internal wallet: mint on testnet, float on mainnet)
  //    and wait for the DEPOSIT credit.
  const { credited } = await fundSubaccount(ctx.slot, assets6);

  // 4. Grow the position, same side.
  let filled6 = 0n;
  let fill18 = 0n;
  if (addedSize6 > 0n) {
    const clientId = clientIdFor("b", ctx.positionToken);
    await db.ledgerEntry.update({ where: { id: entry.id }, data: { arcusClientId: clientId } });
    const outcome = await placeMarketOrder({
      credentials,
      market: ctx.market,
      side: ctx.side,
      quantity: fromSize6(addedSize6),
      clientId,
    });
    if (outcome.unfilled) {
      // The buyer still gets their shares at NAV: the deposit backs the position as margin.
      log.warn("buy-in order did not fill; adding as margin only", {
        positionId: ctx.position.id,
        status: outcome.status,
        reason: outcome.cancelReason ?? outcome.rejectReason,
      });
    } else {
      filled6 = toSize6(outcome.filledSize);
      fill18 = toPrice18(outcome.averagePrice);
    }
  }

  // 5. Top up the isolated margin with whatever the order did not take, so the
  //    whole buy-in backs the position (the order only took notional / L_set).
  const leftover6 = credited - marginUsed6(filled6, fill18, ctx.position.leverage);
  const movable6 = minBigInt(leftover6, await withdrawable6(ctx.slot));
  // Cents only: the gateway converts dollars, sub-cent dust stays free.
  const cents6 = movable6 - (movable6 % 10_000n);
  let marginNote = "no margin top-up";
  if (cents6 > 0n) {
    const result = await adjustIsolatedMargin(credentials, {
      marketId: ctx.market.arcusMarketId,
      amount: fromUsdg6(cents6),
    });
    marginNote = `adjustIsolatedMargin +${fromUsdg6(cents6)} -> ${result.status}`;
  }

  await markConfirmed(entry.id, {
    filledSize: filled6.toString(),
    fillPrice: fill18.toString(),
    note: `grew ${fromSize6(filled6)} @ ${fill18 > 0n ? fromPrice18(fill18) : "-"}; ${marginNote}`,
  });
}

// ---------------------------------------------------------------------------
// Redeem (Arcus spec §5 redeem leg, replaced)
// ---------------------------------------------------------------------------

async function runRedeem(ctx: Context, entry: LedgerEntry, shares: bigint): Promise<void> {
  const credentials = credentialsFor(ctx.slot);

  // 1. Fresh report.
  const { mark18, leg } = await pushFreshReport({ positionToken: ctx.positionToken, credentials, market: ctx.market });

  // 2. Size the reduction: shares / supply of the size (supply still includes
  //    the pending shares), rounded to the step. Below the minimum order size
  //    there is no Arcus order -- tiny redeems come out of the buffer.
  const state = await readPositionState(ctx.positionToken);
  const closedSize6 = redeemClosedSize({
    shares,
    supply: state.totalSupply,
    size6: state.size,
    legSize6: leg ? toSize6(leg.size) : 0n,
    mark18,
    grid: ctx.market,
  });

  let filled6 = 0n;
  let fill18 = 0n;
  if (closedSize6 > 0n && leg) {
    const clientId = clientIdFor("r", ctx.positionToken);
    await db.ledgerEntry.update({ where: { id: entry.id }, data: { arcusClientId: clientId } });
    const outcome = await placeMarketOrder({
      credentials,
      market: ctx.market,
      side: isLongSide(leg.side) ? "SELL" : "BUY",
      quantity: fromSize6(closedSize6),
      reduceOnly: true,
      clientId,
    });
    if (outcome.unfilled) {
      throw new Error(
        `Proportional reduce-only order did not fill (${outcome.status}${outcome.cancelReason ? `: ${outcome.cancelReason}` : ""})`,
      );
    }
    filled6 = toSize6(outcome.filledSize);
    fill18 = toPrice18(outcome.averagePrice);
  }

  await markConfirmed(entry.id, {
    filledSize: filled6.toString(),
    fillPrice: fill18.toString(),
    note: filled6 > 0n ? `reduced ${fromSize6(filled6)}` : "below minimum order size; paid from buffer",
  });
}

/**
 * 3. Make sure the token can pay: `payout = shares x navPerShare() / 1e18`,
 * never counting USDG that belongs to still-pending buyers (they can cancel and
 * take it back). The internal wallet transfers in any shortfall (minting it
 * first on testnet).
 */
async function ensureRedeemFunds(ctx: Context, shares: bigint): Promise<bigint> {
  const payout = (shares * (await navPerShare(ctx.positionToken))) / PRICE_SCALE;
  await fundPayout(ctx.slot, ctx.positionToken, payout);
  return payout;
}

/// Tops the token up until what it holds beyond pending buy-ins covers
/// `payout`. Shared by redeems and SL/TP trigger exits.
export async function fundPayout(slot: SlotWithWallet, positionToken: Address, payout: bigint): Promise<void> {
  const [balance, reserved] = await Promise.all([
    usdgBalanceOf(positionToken),
    totalPendingDepositAssets(positionToken),
  ]);
  const available = balance > reserved ? balance - reserved : 0n;
  if (available >= payout) return;

  const shortfall = payout - available;
  await ensureInternalWalletFloat(slot, shortfall);
  await transferUsdg(walletForSlot(slot), positionToken, shortfall);
  log.info("payout topped up from the internal wallet", {
    positionToken,
    shortfall: fromUsdg6(shortfall),
  });
}

/// 5. Recycle, off the critical path: withdraw the margin the reduce freed back
/// to the internal wallet so the float refills.
export function recycleFreedMargin(ctx: { slot: SlotWithWallet; position: { id: string } }, amount6: bigint): void {
  void (async () => {
    const handle = await withdrawToInternalWallet(ctx.slot, amount6);
    await awaitWithdrawalApplied(ctx.slot, handle.withdrawalId, { since: handle.submittedAt, amount6: handle.amount6 });
    log.info("freed margin recycled to the internal wallet", { positionId: ctx.position.id, amount: fromUsdg6(handle.amount6) });
  })().catch((error) =>
    log.warn("freed-margin recycle skipped", { positionId: ctx.position.id, ...errorFields(error) }),
  );
}

// ---------------------------------------------------------------------------
// The on-chain leg
// ---------------------------------------------------------------------------

/**
 * Settle with the fill recorded on the ledger row. The fulfil settles in the
 * same transaction, so after it succeeds there is nothing left but the ledger
 * write.
 *
 * `pending == 0` before the call means one of two things: the user cancelled
 * (their cancel event is on-chain after the request), or this process already
 * fulfilled it and died before recording that. The chain tells them apart.
 */
async function completeOnChain(direction: Direction, event: RequestEvent, entryId: string): Promise<void> {
  const positionToken = event.positionTokenAddress as Address;
  const controller = event.controller as Address;

  const stillPending =
    direction === "add" ? await pendingDeposit(positionToken, controller) : await pendingRedeem(positionToken, controller);

  if (stillPending === 0n) {
    if (await wasCancelledSince(direction, positionToken, controller, event.blockNumber)) {
      await cancelEntry(entryId, "user cancelled the on-chain request before it was fulfilled");
    } else {
      await markOnchainFulfilled(entryId);
    }
    return;
  }

  const entry = await db.ledgerEntry.findUniqueOrThrow({ where: { id: entryId } });
  const size6 = BigInt(entry.filledSize ?? "0");
  const price18 = BigInt(entry.fillPrice ?? "0");

  try {
    let txHash: string;
    if (direction === "add") {
      txHash = await fulfillDepositRequest({ positionToken, controller, addedSize: size6, fillPrice: price18 });
    } else {
      const ctx = await contextFor(event.positionId);
      if (!ctx) throw new Error(`Position ${event.positionId} is not open; cannot fund the redeem`);
      const settled = await fulfilRedeemFunded(ctx, controller, stillPending, size6, price18);
      txHash = settled.txHash;
      // The reduce freed roughly the redeemer's share of equity as margin.
      if (size6 > 0n) recycleFreedMargin(ctx, settled.payout);
    }

    await markOnchainFulfilled(entryId);
    log.info("request fulfilled and settled on-chain", {
      positionId: event.positionId,
      direction,
      txHash,
      size: fromSize6(size6),
    });
  } catch (error) {
    if (isNoPendingRevert(error)) {
      // The cancel landed between the read and the write. Not retried.
      await cancelEntry(entryId, "user cancelled the on-chain request before it was fulfilled");
      return;
    }
    // Anything else (RPC, gas) leaves the entry confirmed-but-unfulfilled; the
    // reconciler retries it while the request is still pending.
    log.error("fulfil call failed; left for the reconciler to retry", {
      positionId: event.positionId,
      direction,
      ...errorFields(error),
    });
    throw error;
  }
}

/// Fund, then fulfil. A report landing in between can move NAV up a little;
/// one re-fund and retry covers it.
async function fulfilRedeemFunded(
  ctx: Context,
  controller: Address,
  shares: bigint,
  closedSize6: bigint,
  fillPrice18: bigint,
): Promise<{ txHash: string; payout: bigint }> {
  for (let attempt = 1; ; attempt += 1) {
    const payout = await ensureRedeemFunds(ctx, shares);
    try {
      const txHash = await fulfillRedeemRequest({
        positionToken: ctx.positionToken,
        controller,
        closedSize: closedSize6,
        fillPrice: fillPrice18,
      });
      return { txHash, payout };
    } catch (error) {
      const short = /insufficient assets/i.test(error instanceof Error ? error.message : String(error));
      if (!short || attempt >= 2) throw error;
    }
  }
}

const cancelledEvents = {
  add: parseAbiItem("event DepositRequestCancelled(address indexed controller, uint256 assets)"),
  remove: parseAbiItem("event RedeemRequestCancelled(address indexed controller, uint256 shares)"),
} as const;

async function wasCancelledSince(
  direction: Direction,
  positionToken: Address,
  controller: Address,
  fromBlock: bigint,
): Promise<boolean> {
  const logs = await publicClient().getLogs({
    address: positionToken,
    event: cancelledEvents[direction],
    args: { controller },
    fromBlock,
    toBlock: "latest",
  });
  return logs.length > 0;
}

/**
 * Mark an entry `cancelled` and undo whatever it moved on Arcus.
 *
 * Idempotent across the two paths that can reach it (this flow noticing the
 * cancel, and the indexer's cancel-event handler): the status flip is a
 * conditional update, and only the caller that wins it touches Arcus.
 */
export async function cancelEntry(entryId: string, reason: string): Promise<void> {
  const entry = await db.ledgerEntry.findUnique({ where: { id: entryId } });
  if (!entry || entry.arcusStatus === "cancelled" || entry.arcusStatus === "reversed") return;
  if (entry.onchainFulfilledAt) return; // settled; nothing to cancel

  if (entry.arcusStatus === "pending") {
    // Nothing is known to have moved on Arcus. If the in-flight handler does
    // move it, its completeOnChain sees the cancel and comes back here.
    await db.ledgerEntry.updateMany({
      where: { id: entryId, arcusStatus: "pending" },
      data: { arcusStatus: "cancelled", note: `Cancelled before reaching Arcus: ${reason}`.slice(0, 500) },
    });
    return;
  }

  const won = await db.ledgerEntry.updateMany({
    where: { id: entryId, arcusStatus: "confirmed", onchainFulfilledAt: null },
    data: { arcusStatus: "cancelled" },
  });
  if (won.count === 0) return;

  try {
    await reverseOnArcus(entry);
  } catch (error) {
    await db.ledgerEntry.update({ where: { id: entryId }, data: { arcusStatus: "confirmed" } });
    throw error;
  }
  await markCancelled(entryId, reason);
}

/**
 * Undo an Arcus leg whose request was cancelled on-chain. The contract never
 * changed size for it, so Arcus goes back to match:
 *   - cancelled buy-in: reduce-only close of the size it added, then withdraw
 *     the funding back to the internal wallet (best effort).
 *   - cancelled redeem: re-open the size it closed -- the shares came back.
 */
async function reverseOnArcus(entry: LedgerEntry): Promise<void> {
  const ctx = await contextFor(entry.positionId);
  if (!ctx) throw new Error(`cannot reverse entry ${entry.id}: position not open`);
  const credentials = credentialsFor(ctx.slot);
  const size6 = BigInt(entry.filledSize ?? "0");

  if (size6 > 0n) {
    const leg = await findLeg(credentials, ctx.market.arcusMarketId);
    const opposite: OrderSide = ctx.side === "BUY" ? "SELL" : "BUY";
    const outcome = await placeMarketOrder({
      credentials,
      market: ctx.market,
      side: entry.type === "margin_add" ? opposite : ctx.side,
      quantity: fromSize6(entry.type === "margin_add" && leg ? minBigInt(size6, toSize6(leg.size)) : size6),
      reduceOnly: entry.type === "margin_add",
      clientId: clientIdFor("x", entry.id),
    });
    if (outcome.unfilled) throw new Error(`reversal order for entry ${entry.id} did not fill (${outcome.status})`);
  }

  if (entry.type === "margin_add") recycleFreedMargin(ctx, BigInt(entry.amount));
  if (entry.type === "margin_remove" && size6 > 0n) {
    alert("redeem cancelled after the reduce; Arcus size re-opened at a new price", {
      entryId: entry.id,
      positionId: entry.positionId,
    });
  }
  log.warn("reversed a cancelled request on Arcus", { entryId: entry.id, type: entry.type, size: fromSize6(size6) });
}

/// Reconciler hook: retry the on-chain leg of an entry that confirmed on Arcus
/// but never reached fulfil (RPC failure, restart).
export async function retryFulfil(entryId: string): Promise<void> {
  const entry = await db.ledgerEntry.findUnique({ where: { id: entryId }, include: { position: true } });
  if (!entry || !entry.position.positionTokenAddress || !entry.controller || !entry.txHash) return;

  const receipt = await publicClient().getTransactionReceipt({ hash: entry.txHash as `0x${string}` });
  await completeOnChain(
    entry.type === "margin_add" ? "add" : "remove",
    {
      positionId: entry.positionId,
      positionTokenAddress: entry.position.positionTokenAddress,
      amount: 0n, // unused past the Arcus leg
      controller: entry.controller,
      requestId: entry.onchainRequestId ?? "0",
      txHash: entry.txHash,
      logIndex: entry.logIndex ?? 0,
      blockNumber: receipt.blockNumber,
    },
    entry.id,
  );
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
