import type { LedgerEntry, Position } from "@prisma/client";
import { parseAbiItem, type Address } from "viem";

import { db } from "../config/db";
import { floatAddress, publicClient } from "../chain/clients";
import {
  assetBalanceOf,
  fulfillDepositRequest,
  fulfillRedeemRequest,
  isNoPendingRevert,
  navPerShare,
  pendingDeposit,
  pendingRedeem,
  readPositionState,
  tokenLeverage,
  totalPendingDepositAssets,
  transferAsset,
} from "../chain/writes";
import { alert, createLogger, errorFields } from "../lib/logger";
import { PRICE_SCALE, fromAsset6, fromPrice18, fromSize6 } from "../lib/units";
import { saveLedgerRequest } from "../venue/requests";
import { venue } from "../venue/types";
import { getSlotForPosition, slotWallet, type SlotWithWallet } from "./allocator";
import { ensureSlotFloat, withSlotLock } from "./float";
import {
  findEntryForLog,
  markCancelled,
  markConfirmed,
  markOnchainFulfilled,
  recordPending,
  type LedgerType,
} from "./ledger";
import { marketForPosition, requireMarket, type ResolvedMarket } from "./markets";
import { pushFreshFunding } from "./reporter";
import { buyInAddedSize, redeemClosedSize } from "./sizing";
import { closeSide, isUnknownOutcome, openSide, placeAndResolve, resolveSent, savedRequest } from "./venueOrders";

const log = createLogger("margin");

/**
 * Buy-ins and redeems on a live position.
 *
 * The rule: a buy-in or redeem changes how BIG the position is, never how
 * LEVERAGED. Every share always represents the same slice of the same trade.
 *
 *   buy-in of `a`          -> the venue position grows by ΔS = a x S / V
 *   redeem of `s` shares   -> it shrinks by f = s / supply; the redeemer gets f x V
 *
 * The on-chain vault locks the funds first (requestDeposit / requestRedeem);
 * the venue leg moves; then the fulfil settles in one transaction, priced by
 * the contract itself at navPerShare() -- after a fresh funding push, so the
 * NAV is current. Buyers pay exactly NAV and redeemers receive exactly NAV.
 *
 * The venue leg can succeed while the fulfil fails: the user may have
 * cancelled after the 20-minute timeout, so the fulfil reverts "no pending
 * ..." and the venue move is undone. That is a cancellation, not an error.
 *
 * Every step records what it learned on the ledger row (`pending` before the
 * first venue call, each order's rq/lb before it is sent, the fill on
 * `confirmed`), so the reconciler can finish a fulfil after a restart.
 *
 * Funding: a buyer's asset stays inside the PositionToken as the payout buffer
 * for future redeems; the venue side is funded from the float (float.ts). A
 * redeem payout the token cannot cover is topped up from the float; freed
 * margin is withdrawn back to it afterwards (off the critical path).
 *
 * Every order goes out at the token's own leverage (token.leverage()): Perpl
 * re-margins the whole position to each order's `lv`. Whatever margin a
 * buy-in's order does not take stays as free account balance -- the funding
 * reconciliation (reporter.ts venueTotal) already counts it. There is no t:6
 * top-up: the next size change would re-margin it away anyway
 * (docs/perpl-findings.md#f-remargin).
 */

type Direction = "add" | "remove";

export interface RequestEvent {
  positionId: string;
  positionTokenAddress: string;
  /// `assets` for a deposit, `shares` for a redeem. Asset base units / shares.
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
  /// token.leverage() -- the `lv` of every order for this position.
  leverage: number;
}

async function contextFor(positionId: string, options: { anyStatus?: boolean } = {}): Promise<Context | null> {
  const position = await db.position.findUnique({ where: { id: positionId } });
  if (!position || position.status !== "open" || !position.positionTokenAddress) {
    log.warn("margin request for a position that is not open", { positionId, status: position?.status });
    return null;
  }
  const slot = await getSlotForPosition(positionId);
  if (!slot) throw new Error(`Position ${positionId} has no allocated slot`);
  const positionToken = position.positionTokenAddress as Address;
  return {
    position,
    positionToken,
    slot,
    market: options.anyStatus ? await marketForPosition(position.market) : await requireMarket(position.market),
    leverage: await tokenLeverage(positionToken),
  };
}

async function handleMarginRequest(direction: Direction, event: RequestEvent): Promise<void> {
  // Indexer replays are normal after a restart; one ledger row per emitting
  // log keeps a re-read of the same block from double-moving anything.
  const existing = await findEntryForLog(event.txHash, event.logIndex);
  if (existing) {
    log.debug("margin request already recorded", { entryId: existing.id, status: existing.venueStatus });
    if (existing.venueStatus === "confirmed" && !existing.onchainFulfilledAt) {
      await completeOnChain(direction, event, existing.id);
    }
    return;
  }

  const ctx = await contextFor(event.positionId);
  if (!ctx) return;

  // `pending` before the first venue call, always. A redeem's asset value is
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

  if (direction === "add") {
    // A buy-in whose order did not fill is cancelled, never fulfilled.
    if (!(await runBuyIn(ctx, entry, event.amount))) return;
  } else {
    await runRedeem(ctx, entry, event.amount);
  }

  await completeOnChain(direction, event, entry.id);
}

// ---------------------------------------------------------------------------
// Buy-in
// ---------------------------------------------------------------------------

/// Returns false when the order did not fill and the buy-in was cancelled.
async function runBuyIn(ctx: Context, entry: LedgerEntry, assets6: bigint): Promise<boolean> {
  // 1. Fresh funding, so navPerShare() is current when the fulfil prices shares.
  await pushFreshFunding(ctx.position, ctx.slot, ctx.market);

  // 2. Size the add: the buyer's proportional share, on the lot grid, capped
  //    so the order never needs more margin than the buy-in brought.
  const state = await readPositionState(ctx.positionToken);
  const addedSize6 = buyInAddedSize({
    assets6,
    size6: state.size,
    totalAssets6: state.totalAssets,
    leverage: ctx.leverage,
    mark18: state.markPrice,
    grid: ctx.market,
  });

  const result = await withSlotLock(ctx.slot.id, async () => {
    // 3. Fund the account from the float. Credited in the same transaction.
    await ensureSlotFloat(ctx.slot, assets6);
    await venue().deposit(ctx.slot, assets6);

    // 4. Grow the position, same side, the token's leverage. Below the minimum
    //    order size there is no order: the deposit stays as free balance.
    if (addedSize6 === 0n) return { filled: true, fill18: 0n, orderNote: "no order (below the minimum size)" };
    const outcome = await placeAndResolve(
      ctx.slot,
      ctx.market,
      { side: openSide(ctx.position.direction), size6: addedSize6, leverage: ctx.leverage },
      (request) => saveLedgerRequest(entry.id, ctx.slot.id, request),
    );
    if (outcome.status === "unfilled" || outcome.status === "failed") {
      return { filled: false, fill18: 0n, orderNote: `order ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}` };
    }
    if (outcome.orderId) await db.ledgerEntry.update({ where: { id: entry.id }, data: { venueOrderId: outcome.orderId } });
    return {
      filled: true,
      fill18: outcome.avgPrice18,
      orderNote: `order ${outcome.status} ${fromSize6(outcome.filledSize6)} @ ${fromPrice18(outcome.avgPrice18)}`,
    };
  });

  if (!result.filled) {
    // Cancel: no fulfil, so the buyer's asset stays pending in the token and
    // they take it back with cancelDepositRequest() after the timeout. The
    // float money deposited for the order goes back to the float.
    log.warn("buy-in order did not fill; buy-in cancelled", { positionId: ctx.position.id, note: result.orderNote });
    await markCancelled(entry.id, `buy-in cancelled: ${result.orderNote}; the buyer can reclaim it with cancelDepositRequest()`);
    recycleFreedMargin(ctx, assets6);
    return false;
  }

  // 5. What goes on-chain comes from the chain: the venue size now, less the
  //    token's size before.
  const after = await venue().getPosition(ctx.slot, ctx.market);
  const filled6 = after.size6 > state.size ? after.size6 - state.size : 0n;
  const fill18 = filled6 > 0n ? (result.fill18 > 0n ? result.fill18 : after.entry18) : 0n;

  await markConfirmed(entry.id, {
    filledSize: filled6.toString(),
    fillPrice: fill18.toString(),
    note: `grew ${fromSize6(filled6)} @ ${fill18 > 0n ? fromPrice18(fill18) : "-"}; ${result.orderNote}`,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Redeem
// ---------------------------------------------------------------------------

async function runRedeem(ctx: Context, entry: LedgerEntry, shares: bigint): Promise<void> {
  // 1. Fresh funding.
  await pushFreshFunding(ctx.position, ctx.slot, ctx.market);

  // 2. Size the reduction: shares / supply of the size (supply still includes
  //    the pending shares), on the lot grid. Below the minimum order size there
  //    is no venue order -- tiny redeems come out of the buffer.
  const state = await readPositionState(ctx.positionToken);
  const leg = await venue().getPosition(ctx.slot, ctx.market);
  const closedSize6 = redeemClosedSize({
    shares,
    supply: state.totalSupply,
    size6: state.size,
    legSize6: leg.exists ? leg.size6 : 0n,
    mark18: state.markPrice,
    grid: ctx.market,
  });

  let fill18 = 0n;
  if (closedSize6 > 0n && leg.exists) {
    const outcome = await withSlotLock(ctx.slot.id, () =>
      placeAndResolve(
        ctx.slot,
        ctx.market,
        { side: closeSide(ctx.position.direction), size6: closedSize6, leverage: ctx.leverage },
        (request) => saveLedgerRequest(entry.id, ctx.slot.id, request),
      ),
    );
    if (outcome.status === "unfilled" || outcome.status === "failed") {
      throw new Error(
        `Proportional reduce order did not fill (${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ""})`,
      );
    }
    fill18 = outcome.avgPrice18;
    if (outcome.orderId) await db.ledgerEntry.update({ where: { id: entry.id }, data: { venueOrderId: outcome.orderId } });
  }

  // 4. The closed size as the chain sees it: the token's size less the venue's now.
  const after = await venue().getPosition(ctx.slot, ctx.market);
  const venueAfter = after.exists ? after.size6 : 0n;
  const closed6 = state.size > venueAfter ? state.size - venueAfter : 0n;
  const price18 = closed6 > 0n ? (fill18 > 0n ? fill18 : state.markPrice) : 0n;

  await markConfirmed(entry.id, {
    filledSize: closed6.toString(),
    fillPrice: price18.toString(),
    note: closed6 > 0n ? `reduced ${fromSize6(closed6)}` : "below minimum order size; paid from buffer",
  });
}

/**
 * Make sure the token can pay: `payout = shares x navPerShare() / 1e18`,
 * never counting asset that belongs to still-pending buyers (they can cancel
 * and take it back).
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
    assetBalanceOf(positionToken),
    totalPendingDepositAssets(positionToken),
  ]);
  const available = balance > reserved ? balance - reserved : 0n;
  if (available >= payout) return;

  const shortfall = payout - available;
  await ensureSlotFloat(slot, shortfall);
  await transferAsset(slotWallet(slot), positionToken, shortfall);
  log.info("payout topped up from the float", { positionToken, shortfall: fromAsset6(shortfall) });
}

/**
 * Recycle, off the critical path: withdraw the account's free balance above
 * the reserve (the margin a reduce freed) to the slot wallet, then move the
 * wallet's asset to the float so it refills.
 */
export function recycleFreedMargin(ctx: { slot: SlotWithWallet; position: { id: string } }, _amount: bigint): void {
  void withSlotLock(ctx.slot.id, async () => {
    const reserve = BigInt(ctx.slot.reserve);
    const free = await venue().accountBalance(ctx.slot);
    const excess = free > reserve ? free - reserve : 0n;
    if (excess > 0n) await venue().withdraw(ctx.slot, excess);
    const held = await assetBalanceOf(ctx.slot.operatorWallet.address as Address);
    if (held > 0n) await transferAsset(slotWallet(ctx.slot), floatAddress(), held);
    log.info("freed margin recycled to the float", { positionId: ctx.position.id, amount: fromAsset6(held) });
  }).catch((error) => log.warn("freed-margin recycle skipped", { positionId: ctx.position.id, ...errorFields(error) }));
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
      const ctx = await contextFor(event.positionId, { anyStatus: true });
      if (!ctx) throw new Error(`Position ${event.positionId} is not open; cannot fund the redeem`);
      const settled = await fulfilRedeemFunded(ctx, controller, stillPending, size6, price18);
      txHash = settled.txHash;
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

/// Fund, then fulfil. A funding push landing in between can move NAV up a
/// little; one re-fund and retry covers it.
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
 * Mark an entry `cancelled` and undo whatever it moved on the venue.
 *
 * Idempotent across the two paths that can reach it (this flow noticing the
 * cancel, and the indexer's cancel-event handler): the status flip is a
 * conditional update, and only the caller that wins it touches the venue.
 */
export async function cancelEntry(entryId: string, reason: string): Promise<void> {
  const entry = await db.ledgerEntry.findUnique({ where: { id: entryId } });
  if (!entry || entry.venueStatus === "cancelled" || entry.venueStatus === "reversed") return;
  if (entry.onchainFulfilledAt) return; // settled; nothing to cancel

  if (entry.venueStatus === "pending") {
    // Nothing is known to have moved on the venue. If the in-flight handler
    // does move it, its completeOnChain sees the cancel and comes back here.
    await db.ledgerEntry.updateMany({
      where: { id: entryId, venueStatus: "pending" },
      data: { venueStatus: "cancelled", note: `Cancelled before reaching the venue: ${reason}`.slice(0, 500) },
    });
    return;
  }

  const won = await db.ledgerEntry.updateMany({
    where: { id: entryId, venueStatus: "confirmed", onchainFulfilledAt: null },
    data: { venueStatus: "cancelled" },
  });
  if (won.count === 0) return;

  try {
    await reverseOnVenue(entry);
  } catch (error) {
    await db.ledgerEntry.update({ where: { id: entryId }, data: { venueStatus: "confirmed" } });
    throw error;
  }
  await markCancelled(entryId, reason);
}

/**
 * Undo a venue leg whose request was cancelled on-chain. The contract never
 * changed size for it, so the venue goes back to match:
 *   - cancelled buy-in: close the size it added, then withdraw the funding
 *     back to the float (best effort).
 *   - cancelled redeem: re-open the size it closed -- the shares came back.
 */
async function reverseOnVenue(entry: LedgerEntry): Promise<void> {
  const ctx = await contextFor(entry.positionId, { anyStatus: true });
  if (!ctx) throw new Error(`cannot reverse entry ${entry.id}: position not open`);
  const size6 = BigInt(entry.filledSize ?? "0");

  if (size6 > 0n) {
    const isBuyIn = entry.type === "margin_add";
    const leg = await venue().getPosition(ctx.slot, ctx.market);
    const reverseSize = isBuyIn && leg.exists && leg.size6 < size6 ? leg.size6 : size6;
    const outcome = await withSlotLock(ctx.slot.id, () =>
      placeAndResolve(
        ctx.slot,
        ctx.market,
        {
          side: isBuyIn ? closeSide(ctx.position.direction) : openSide(ctx.position.direction),
          size6: reverseSize,
          leverage: ctx.leverage,
        },
        (request) => saveLedgerRequest(entry.id, ctx.slot.id, request),
      ),
    );
    if (outcome.status === "unfilled" || outcome.status === "failed") {
      throw new Error(`reversal order for entry ${entry.id} did not fill (${outcome.status})`);
    }
  }

  if (entry.type === "margin_add") recycleFreedMargin(ctx, BigInt(entry.amount));
  if (entry.type === "margin_remove" && size6 > 0n) {
    alert("redeem cancelled after the reduce; venue size re-opened at a new price", {
      entryId: entry.id,
      positionId: entry.positionId,
    });
  }
  log.warn("reversed a cancelled request on the venue", { entryId: entry.id, type: entry.type, size: fromSize6(size6) });
}

/**
 * Reconciler hook ("retry next tick"): a redeem still `pending` -- its reduce
 * was not placed after every attempt, or the process died mid-way. Its own
 * saved order is decided first (lot rule), so a reduce that did fill is
 * recorded, never repeated; only when nothing moved is the redeem run again.
 * A user who cancelled meanwhile is handled by the on-chain leg.
 */
export async function retryPendingRedeem(entryId: string): Promise<void> {
  const entry = await db.ledgerEntry.findUnique({ where: { id: entryId }, include: { position: true } });
  if (!entry || entry.type !== "margin_remove" || entry.venueStatus !== "pending") return;
  if (!entry.controller || !entry.txHash || !entry.requestAmount || !entry.position.positionTokenAddress) return;
  const ctx = await contextFor(entry.positionId);
  if (!ctx) return;

  const receipt = await publicClient().getTransactionReceipt({ hash: entry.txHash as `0x${string}` });
  const event: RequestEvent = {
    positionId: entry.positionId,
    positionTokenAddress: entry.position.positionTokenAddress,
    amount: BigInt(entry.requestAmount),
    controller: entry.controller,
    requestId: entry.onchainRequestId ?? "0",
    txHash: entry.txHash,
    logIndex: entry.logIndex ?? 0,
    blockNumber: receipt.blockNumber,
  };

  // The user may have cancelled meanwhile: the on-chain leg sees that.
  if ((await pendingRedeem(ctx.positionToken, entry.controller as Address)) === 0n) {
    await completeOnChain("remove", event, entry.id);
    return;
  }

  const sent = savedRequest(entry);
  let found: Awaited<ReturnType<typeof resolveSent>> = "not_placed";
  if (sent) {
    try {
      found = await withSlotLock(ctx.slot.id, () => resolveSent(ctx.slot, ctx.market, sent));
    } catch (error) {
      if (isUnknownOutcome(error)) return; // the chain is not past lb yet; next tick
      throw error;
    }
  }
  if (found !== "not_placed" && (found.status === "filled" || found.status === "partial")) {
    await markConfirmed(entry.id, {
      filledSize: found.filledSize6.toString(),
      fillPrice: found.avgPrice18.toString(),
      note: `reduced ${fromSize6(found.filledSize6)} (resolved on retry: ${found.reason ?? found.status})`,
    });
  } else {
    log.info("retrying a redeem whose reduce never filled", { entryId, positionId: entry.positionId });
    await runRedeem(ctx, entry, BigInt(entry.requestAmount));
  }
  await completeOnChain("remove", event, entry.id);
}

/// Reconciler hook: retry the on-chain leg of an entry that confirmed on the
/// venue but never reached fulfil (RPC failure, restart).
export async function retryFulfil(entryId: string): Promise<void> {
  const entry = await db.ledgerEntry.findUnique({ where: { id: entryId }, include: { position: true } });
  if (!entry || !entry.position.positionTokenAddress || !entry.controller || !entry.txHash) return;

  const receipt = await publicClient().getTransactionReceipt({ hash: entry.txHash as `0x${string}` });
  await completeOnChain(
    entry.type === "margin_add" ? "add" : "remove",
    {
      positionId: entry.positionId,
      positionTokenAddress: entry.position.positionTokenAddress,
      amount: 0n, // unused past the venue leg
      controller: entry.controller,
      requestId: entry.onchainRequestId ?? "0",
      txHash: entry.txHash,
      logIndex: entry.logIndex ?? 0,
      blockNumber: receipt.blockNumber,
    },
    entry.id,
  );
}
