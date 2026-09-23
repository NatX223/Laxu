import type { LedgerEntry } from "@prisma/client";
import { parseAbiItem, type Address } from "viem";

import { adjustIsolatedMargin, getPositions, placeOrder } from "../arcus/client";
import { getArcusStream } from "../arcus/ws";
import { db } from "../config/db";
import { config } from "../config/env";
import { PRICE_SCALE, operatorWallet, publicClient, usdgDecimals } from "../chain/clients";
import { positionTokenAbi } from "../chain/abi";
import {
  fulfillDepositRequest,
  fulfillRedeemRequest,
  isNoPendingRevert,
  mintUsdg,
  navPerShare,
  pendingDeposit,
  pendingRedeem,
  totalSupply,
  usdgBalanceOf,
} from "../chain/writes";
import {
  applyBps,
  ceilToStep,
  compareDecimal,
  floorToStep,
  formatDecimal,
  fromBaseUnits,
  negateDecimal,
  parseDecimal,
} from "../lib/decimal";
import { alert, createLogger, errorFields } from "../lib/logger";
import { credentialsFor, getSlotForPosition } from "./allocator";
import { fundSubaccountFromMint } from "./arcusFunding";
import {
  findEntryForLog,
  markCancelled,
  markConfirmed,
  markOnchainFulfilled,
  recordPending,
  type LedgerType,
} from "./ledger";
import { markPriceFor, requireMarket, type ResolvedMarket } from "./markets";

const log = createLogger("margin");

/**
 * Adding and removing margin on a position that already exists.
 *
 * The on-chain vault is live here, so it locks the funds before anything
 * reaches Arcus:
 *
 *   requestDeposit() on-chain  ->  margin moves on Arcus  ->
 *   fulfillDepositRequest() on-chain (settles: shares minted to the buyer)
 *
 * The middle step is the one that can succeed while the last one fails: the
 * user may have cancelled their request after the 20-minute timeout, in which
 * case the fulfil reverts with "no pending ..." and the Arcus-side move has to
 * be undone. That is a cancellation, not an error -- never retried.
 *
 * A redeem is NOT a plain margin withdrawal, though: pulling margin alone
 * while the Arcus position size stays fixed would raise effective leverage
 * for every remaining holder without their consent. So a redeem additionally
 * places a `reduceOnly` order first, sized to exactly the redeemer's
 * fractional share of the position (shares / totalSupply at request time) --
 * see {reducePositionProportionally}. Size and margin shrink together, so the
 * leverage ratio stays identical for everyone who stays in.
 *
 * Known limitations (testnet, where USDG is freely mintable -- fix before
 * mainnet with an operator-only sweep/top-up pair on PositionToken):
 *   - Buy-in USDG stays inside the PositionToken; nothing moves it to Arcus.
 *     The Arcus margin increase is funded from USDG the slot's internal wallet
 *     mints and deposits itself ({fundSubaccountFromMint}).
 *   - fulfillRedeemRequest checks the token's own USDG balance, so before a
 *     redeem is fulfilled the operator mints any shortfall into the token
 *     ({prefundRedeem}). The margin freed on Arcus stays on the subaccount.
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

async function handleMarginRequest(direction: Direction, event: RequestEvent): Promise<void> {
  // Indexer replays are normal after a restart; one ledger row per emitting
  // log keeps a re-read of the same block from double-moving margin.
  const existing = await findEntryForLog(event.txHash, event.logIndex);
  if (existing) {
    log.debug("margin request already recorded", { entryId: existing.id, status: existing.arcusStatus });
    if (existing.arcusStatus === "confirmed" && !existing.onchainFulfilledAt) {
      await completeOnChain(direction, event, existing.id);
    }
    return;
  }

  const position = await db.position.findUnique({ where: { id: event.positionId } });
  if (!position || position.status !== "open") {
    log.warn("margin request for a position that is not open", {
      positionId: event.positionId,
      status: position?.status,
    });
    return;
  }

  const slot = await getSlotForPosition(event.positionId);
  if (!slot) throw new Error(`Position ${event.positionId} has no allocated slot`);

  const market = await requireMarket(position.market);
  const credentials = credentialsFor(slot);
  const decimals = await usdgDecimals();

  // For a redeem the event carries shares, not assets. Value them at the current
  // NAV per share so the amount pulled off Arcus matches what the vault will owe.
  const assets =
    direction === "add"
      ? event.amount
      : (event.amount * (await navPerShare(event.positionTokenAddress as Address))) / PRICE_SCALE;

  // `pending` before the Arcus call, always.
  const entry = await recordPending({
    positionId: event.positionId,
    type: typeFor(direction),
    amount: assets.toString(),
    onchainRequestId: event.requestId,
    controller: event.controller,
    txHash: event.txHash,
    logIndex: event.logIndex,
    note: `on-chain ${direction === "add" ? "requestDeposit" : "requestRedeem"} ${event.txHash}#${event.logIndex}`,
  });

  if (direction === "add") {
    // Testnet: the buy-in's USDG stays in the token, so the subaccount is
    // funded with freshly minted USDG before margin can move onto the leg.
    await fundSubaccountFromMint(slot, assets);
  } else {
    // Shrink the real Arcus position by the same fraction BEFORE pulling
    // margin, so the two move together and leverage for remaining holders is
    // unchanged.
    await reducePositionProportionally({
      credentials,
      market,
      shares: event.amount,
      positionToken: event.positionTokenAddress as Address,
    });
  }

  const dollars = fromBaseUnits(assets, decimals);
  const amount = direction === "add" ? dollars : negateDecimal(dollars);

  const result = await adjustIsolatedMargin(credentials, {
    marketId: market.arcusMarketId,
    amount,
  });

  await markConfirmed(entry.id, {
    arcusRequestId: result.requestId,
    note: `adjustIsolatedMargin ${amount} -> ${result.status}`,
  });

  await completeOnChain(direction, event, entry.id);
}

/**
 * Shrink the live Arcus position by exactly the redeemer's fractional share
 * (`shares / totalSupply()`), via a `reduceOnly` order on the opposite side --
 * the same mechanism {closePosition.ts} uses for a full exit, just sized to a
 * fraction instead of 100%. The redeemed shares were burned at request time
 * but still count in totalSupply() until fulfilled, so it is still the
 * pre-redeem denominator the fraction is defined against.
 *
 * If there is no live leg (or it floors to zero at the market's step size)
 * there is nothing to reduce -- e.g. the position notional is already so
 * small relative to the redeem that the step grid swallows it. That is safe
 * to skip: the margin-only withdrawal that follows does not change leverage
 * when there is no notional behind it.
 */
async function reducePositionProportionally(params: {
  credentials: ReturnType<typeof credentialsFor>;
  market: ResolvedMarket;
  /// Redeemed shares, same base-unit scale as PositionToken.totalSupply().
  shares: bigint;
  positionToken: Address;
}): Promise<void> {
  const { credentials, market, shares, positionToken } = params;

  const supply = await totalSupply(positionToken);
  if (supply === 0n) return;

  const openPositions = await getPositions(credentials.address, credentials.accountIndex);
  const leg = openPositions.find((entry) => entry.marketId === market.arcusMarketId);
  if (!leg || compareDecimal(leg.size, "0") <= 0) {
    log.warn("redeem: no live Arcus leg to reduce, skipping the reduceOnly step", {
      positionToken,
      marketId: market.arcusMarketId,
    });
    return;
  }

  // leg.size * (shares / supply), kept exact via bigint math at leg.size's own
  // decimal precision before flooring to the market's step size.
  const legSize = parseDecimal(leg.size);
  const rawQuantity = formatDecimal({ units: (legSize.units * shares) / supply, scale: legSize.scale });
  const quantity = floorToStep(rawQuantity, market.stepSize);

  if (compareDecimal(quantity, "0") <= 0) {
    log.warn("redeem: proportional size floors to zero at the market step size, skipping", {
      positionToken,
      rawQuantity,
      stepSize: market.stepSize,
    });
    return;
  }

  const side = leg.side === "BUY" ? "SELL" : "BUY";
  const mark = await markPriceFor(market);
  const bound =
    side === "BUY"
      ? applyBps(mark, config.arcusSlippageBps, 18)
      : applyBps(mark, -config.arcusSlippageBps, 18);
  const price = side === "BUY" ? floorToStep(bound, market.tickSize) : ceilToStep(bound, market.tickSize);

  const clientId = `r${positionToken.slice(2, 10)}${Date.now().toString(36)}`.slice(0, 36);

  const stream = getArcusStream();
  await stream.ensureSubscribed(credentials.address, credentials.accountIndex);
  const waiter = stream.expectOrder({
    address: credentials.address,
    accountIndex: credentials.accountIndex,
    clientId,
  });

  let result;
  try {
    result = await placeOrder(credentials, {
      marketId: market.arcusMarketId,
      side,
      orderType: "MARKET",
      timeInForce: "IOC",
      quantity,
      price,
      reduceOnly: true,
      clientId,
      tickSize: market.tickSize,
      stepSize: market.stepSize,
    });
  } catch (error) {
    waiter.cancel();
    throw error;
  }

  waiter.bindOrderId(result.orderId);
  const outcome = await waiter.outcome;

  if (outcome.unfilled) {
    throw new Error(
      `Proportional reduce-only order did not fill (${outcome.status}${
        outcome.cancelReason ? `: ${outcome.cancelReason}` : ""
      })`,
    );
  }

  log.info("redeem: reduced Arcus position proportionally", {
    positionToken,
    quantity,
    filledSize: outcome.filledSize,
    price: outcome.averagePrice,
  });
}

/**
 * Testnet: make sure the token can pay `shares` out at `fulfillmentPrice`
 * without touching USDG that belongs to still-pending buyers (they can cancel
 * and take it back). Mints any shortfall straight into the token.
 */
async function prefundRedeem(positionToken: Address, shares: bigint, fulfillmentPrice: bigint): Promise<void> {
  const owed = (shares * fulfillmentPrice) / PRICE_SCALE;
  const [balance, reserved] = await Promise.all([
    usdgBalanceOf(positionToken),
    publicClient().readContract({
      address: positionToken,
      abi: positionTokenAbi,
      functionName: "totalPendingDepositAssets",
    }) as Promise<bigint>,
  ]);
  const available = balance > reserved ? balance - reserved : 0n;
  if (available >= owed) return;

  const shortfall = owed - available;
  await mintUsdg(operatorWallet(), positionToken, shortfall);
  log.info("prefunded redeem", { positionToken, shortfall: shortfall.toString() });
}

/**
 * The on-chain leg. The fulfil settles in the same transaction, so after it
 * succeeds there is nothing left but the ledger write.
 *
 * `pending == 0` before the call means one of two things: the user cancelled
 * (their cancel event is on-chain after the request), or this process already
 * fulfilled it and died before recording that. The chain tells them apart.
 */
async function completeOnChain(direction: Direction, event: RequestEvent, entryId: string): Promise<void> {
  const positionToken = event.positionTokenAddress as Address;
  const controller = event.controller as Address;

  const stillPending =
    direction === "add"
      ? await pendingDeposit(positionToken, controller)
      : await pendingRedeem(positionToken, controller);

  if (stillPending === 0n) {
    if (await wasCancelledSince(direction, positionToken, controller, event.blockNumber)) {
      await cancelEntry(entryId, "user cancelled the on-chain request before it was fulfilled");
    } else {
      await markOnchainFulfilled(entryId);
    }
    return;
  }

  const fulfillmentPrice = await navPerShare(positionToken);

  try {
    if (direction === "remove") await prefundRedeem(positionToken, stillPending, fulfillmentPrice);

    const txHash =
      direction === "add"
        ? await fulfillDepositRequest({ positionToken, controller, fulfillmentPrice })
        : await fulfillRedeemRequest({ positionToken, controller, fulfillmentPrice });

    await markOnchainFulfilled(entryId);
    log.info("margin request fulfilled and settled on-chain", {
      positionId: event.positionId,
      direction,
      txHash,
      fulfillmentPrice: fulfillmentPrice.toString(),
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

async function reverseOnArcus(entry: LedgerEntry): Promise<void> {
  const position = await db.position.findUnique({ where: { id: entry.positionId } });
  const slot = await getSlotForPosition(entry.positionId);
  if (!position || !slot) {
    throw new Error(`cannot reverse entry ${entry.id}: position or slot missing`);
  }

  const market = await requireMarket(position.market);
  const decimals = await usdgDecimals();
  const dollars = fromBaseUnits(BigInt(entry.amount), decimals);
  // Opposite sign of the original move.
  const amount = entry.type === "margin_add" ? negateDecimal(dollars) : dollars;

  await adjustIsolatedMargin(credentialsFor(slot), { marketId: market.arcusMarketId, amount });

  if (entry.type === "margin_remove") {
    // The margin goes back, but the proportional reduce-only order is not
    // re-opened -- that leg is now smaller than the restored share count.
    // Only reachable when the backend sat on a redeem for 20+ minutes.
    alert("redeem cancelled after the proportional reduce; Arcus size not restored", {
      entryId: entry.id,
      positionId: entry.positionId,
    });
  }
  log.warn("reversed a cancelled margin move on Arcus", { entryId: entry.id, amount });
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
