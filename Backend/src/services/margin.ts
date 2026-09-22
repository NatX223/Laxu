import type { Address } from "viem";

import { adjustIsolatedMargin, getPositions, placeOrder } from "../arcus/client";
import { getArcusStream } from "../arcus/ws";
import { db } from "../config/db";
import { config } from "../config/env";
import { usdgDecimals } from "../chain/clients";
import {
  fulfillDepositRequest,
  fulfillRedeemRequest,
  navPerShare,
  pendingDeposit,
  pendingRedeem,
  totalSupply,
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
import { createLogger, errorFields } from "../lib/logger";
import { credentialsFor, getSlotForPosition } from "./allocator";
import {
  findEntryForRequest,
  markConfirmed,
  markOnchainFulfilled,
  markReversed,
  recordPending,
} from "./ledger";
import { markPriceFor, requireMarket, type ResolvedMarket } from "./markets";

const log = createLogger("margin");

/**
 * Adding and removing margin on a position that already exists.
 *
 * Unlike the first deposit, the on-chain vault is live here, so it locks the
 * funds before anything reaches Arcus:
 *
 *   requestDeposit() on-chain  ->  adjustIsolatedMargin on Arcus  ->
 *   fulfillDepositRequest() on-chain
 *
 * The middle step is the one that can succeed while the last one fails: the
 * user may have reclaimed their request after the on-chain timeout, in which
 * case the fulfil reverts and the Arcus-side move has to be undone.
 *
 * A redeem is NOT a plain margin withdrawal, though: pulling margin alone
 * while the Arcus position size stays fixed would raise effective leverage
 * for every remaining holder without their consent. So a redeem additionally
 * places a `reduceOnly` order first, sized to exactly the redeemer's
 * fractional share of the position (shares / totalSupply at request time) --
 * see {reducePositionProportionally}. Size and margin shrink together, so the
 * leverage ratio stays identical for everyone who stays in.
 */

type Direction = "add" | "remove";

interface RequestEvent {
  positionId: string;
  positionTokenAddress: string;
  /// `assets` for a deposit, `shares` for a redeem. USDG base units / shares.
  amount: bigint;
  controller: string;
  requestId: string;
}

export async function handleDepositRequested(event: RequestEvent): Promise<void> {
  await handleMarginRequest("add", event);
}

export async function handleRedeemRequested(event: RequestEvent): Promise<void> {
  await handleMarginRequest("remove", event);
}

async function handleMarginRequest(direction: Direction, event: RequestEvent): Promise<void> {
  const type = direction === "add" ? "margin_add" : "margin_remove";

  // Indexer replays are normal after a restart; one ledger row per on-chain
  // request keeps a re-read of the same block from double-moving margin.
  const existing = await findEntryForRequest({
    positionId: event.positionId,
    type,
    onchainRequestId: event.requestId,
    controller: event.controller,
  });
  if (existing) {
    log.debug("margin request already recorded", {
      entryId: existing.id,
      status: existing.arcusStatus,
    });
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
      : (event.amount * (await navPerShare(event.positionTokenAddress as Address))) / 10n ** 18n;

  // `pending` before the Arcus call, always.
  const entry = await recordPending({
    positionId: event.positionId,
    type,
    amount: assets.toString(),
    onchainRequestId: event.requestId,
    controller: event.controller,
    note: `on-chain ${direction === "add" ? "requestDeposit" : "requestRedeem"} ${event.requestId}`,
  });

  // Shrink the real Arcus position by the same fraction BEFORE pulling margin,
  // so the two move together and leverage for remaining holders is unchanged.
  if (direction === "remove") {
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
 * fraction instead of 100%. `totalSupply()` is read now, before the
 * fulfil/burn later in this same flow, so it is still the pre-redeem
 * denominator the fraction is defined against.
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
 * The on-chain leg, plus the cancellation race.
 *
 * `fulfill*Request` reverts when the controller has no pending request -- which
 * is exactly what a user who reclaimed after the on-chain timeout leaves behind.
 * That is checked before the call rather than inferred from a revert, and when
 * it happens the Arcus-side move is undone with the opposite amount and the
 * ledger row marked `reversed` rather than left claiming money that never
 * settled.
 */
async function completeOnChain(
  direction: Direction,
  event: RequestEvent,
  entryId: string,
): Promise<void> {
  const positionToken = event.positionTokenAddress as Address;
  const controller = event.controller as Address;

  const stillPending =
    direction === "add"
      ? await pendingDeposit(positionToken, controller)
      : await pendingRedeem(positionToken, controller);

  if (stillPending === 0n) {
    await reverseOnArcus(direction, event, entryId, "on-chain request was cancelled or already fulfilled");
    return;
  }

  const fulfillmentPrice = await navPerShare(positionToken);

  try {
    const txHash =
      direction === "add"
        ? await fulfillDepositRequest({ positionToken, controller, fulfillmentPrice })
        : await fulfillRedeemRequest({ positionToken, controller, fulfillmentPrice });

    await markOnchainFulfilled(entryId);
    log.info("margin request fulfilled on-chain", {
      positionId: event.positionId,
      direction,
      txHash,
      fulfillmentPrice: fulfillmentPrice.toString(),
    });
  } catch (error) {
    // The pre-check narrows this a lot, but the request can still be cancelled
    // between the read and the write.
    log.warn("fulfil call failed; reversing the Arcus-side move", {
      positionId: event.positionId,
      direction,
      ...errorFields(error),
    });
    await reverseOnArcus(
      direction,
      event,
      entryId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function reverseOnArcus(
  direction: Direction,
  event: RequestEvent,
  entryId: string,
  reason: string,
): Promise<void> {
  const entry = await db.ledgerEntry.findUnique({ where: { id: entryId } });
  if (!entry) return;

  // Nothing moved on Arcus yet, so there is nothing to undo.
  if (entry.arcusStatus !== "confirmed") {
    await markReversed(entryId, `Not applied on Arcus: ${reason}`);
    return;
  }

  const position = await db.position.findUnique({ where: { id: event.positionId } });
  const slot = await getSlotForPosition(event.positionId);
  if (!position || !slot) {
    log.error("cannot reverse: position or slot missing", { positionId: event.positionId });
    return;
  }

  const market = await requireMarket(position.market);
  const decimals = await usdgDecimals();
  const dollars = fromBaseUnits(BigInt(entry.amount), decimals);
  // Opposite sign of the original move.
  const amount = direction === "add" ? negateDecimal(dollars) : dollars;

  await adjustIsolatedMargin(credentialsFor(slot), {
    marketId: market.arcusMarketId,
    amount,
  });

  await markReversed(entryId, `Reversed on Arcus (${amount}): ${reason}`.slice(0, 500));
}

export type { RequestEvent };
