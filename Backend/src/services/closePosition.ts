import type { Address } from "viem";

import { getPositions, placeOrder } from "../arcus/client";
import { getArcusStream } from "../arcus/ws";
import { db } from "../config/db";
import { usdgDecimals } from "../chain/clients";
import { closePosition as closeOnChain, creatorHoldsEntireSupply, isClosed } from "../chain/writes";
import {
  applyBps,
  ceilToStep,
  compareDecimal,
  floorToStep,
  isZeroDecimal,
  toBaseUnits,
} from "../lib/decimal";
import { config } from "../config/env";
import { badRequest, conflict, notFound } from "../lib/errors";
import { createLogger, errorFields } from "../lib/logger";
import { credentialsFor, getSlotForPosition, releaseSlot } from "./allocator";
import { markConfirmed, recordPending } from "./ledger";
import { markPriceFor, requireMarket } from "./markets";
import { sweepSubaccount } from "./sweep";

const log = createLogger("close-position");

/**
 * Closing a position.
 *
 * Arcus has no dedicated close endpoint, so the real close is a reduce-only
 * MARKET order on the opposite side, sized to match the open position exactly.
 * The final price comes from the WS fill, same as the open, and only then does
 * the on-chain `close()` land.
 *
 * Access control mirrors the close-access-control spec: only the creator, and
 * only while they hold 100% of supply. That rule is enforced here because
 * `requestClose()` does not exist on the deployed PositionToken yet -- once it
 * does, the indexer's CloseRequested handler calls straight into
 * `executeClose` and the contract enforces it instead.
 */

export async function requestClose(params: {
  positionId: string;
  /// Authenticated caller, from SIWE.
  callerWalletAddress: string;
}): Promise<{ positionId: string; status: string }> {
  const position = await db.position.findUnique({ where: { id: params.positionId } });
  if (!position) throw notFound(`Position ${params.positionId} not found`);
  if (position.status === "closed") throw conflict("Position is already closed", "ALREADY_CLOSED");
  if (position.status !== "open") {
    throw conflict(`Position is ${position.status}, not open`, "NOT_OPEN");
  }
  if (!position.positionTokenAddress) {
    throw conflict("Position has no token address yet", "NOT_OPEN");
  }

  const caller = params.callerWalletAddress.toLowerCase();
  if (position.userWalletAddress.toLowerCase() !== caller) {
    throw badRequest("Only the position creator can close it", "NOT_CREATOR");
  }

  const supply = await creatorHoldsEntireSupply(position.positionTokenAddress as Address);
  if (!supply.ok) {
    throw conflict(
      `Close requires the creator to hold 100% of supply (holds ${supply.creatorBalance} of ${supply.totalSupply})`,
      "SUPPLY_NOT_HELD",
    );
  }

  void executeClose(params.positionId, { wasLiquidated: false }).catch((error) => {
    log.error("close orchestration failed", {
      positionId: params.positionId,
      ...errorFields(error),
    });
  });

  return { positionId: params.positionId, status: "closing" };
}

export async function executeClose(
  positionId: string,
  options: { wasLiquidated?: boolean } = {},
): Promise<void> {
  const position = await db.position.findUnique({ where: { id: positionId } });
  if (!position) throw notFound(`Position ${positionId} not found`);
  if (position.status === "closed") return;
  if (!position.positionTokenAddress) throw new Error(`Position ${positionId} has no token address`);

  const positionToken = position.positionTokenAddress as Address;
  const slot = await getSlotForPosition(positionId);
  if (!slot) throw new Error(`Position ${positionId} has no allocated slot`);

  const market = await requireMarket(position.market);
  const credentials = credentialsFor(slot);
  const decimals = await usdgDecimals();

  // --- 1. Find the live leg on Arcus -------------------------------------
  const openPositions = await getPositions(credentials.address, credentials.accountIndex);
  const leg = openPositions.find((entry) => entry.marketId === market.arcusMarketId);

  let finalMarkPrice: string;
  let finalFunding = "0";

  if (!leg || isZeroDecimal(leg.size)) {
    // Nothing left to unwind -- liquidated, or already flattened out of band.
    // Still settle the on-chain side rather than leaving the token open forever.
    log.warn("no open Arcus leg to close; settling on-chain at mark", {
      positionId,
      marketId: market.arcusMarketId,
    });
    finalMarkPrice = await markPriceFor(market);
  } else {
    finalFunding = leg.cumulativeFunding?.sinceOpen ?? "0";

    // --- 2. Reduce-only, opposite side, sized to match exactly ------------
    const side = leg.side === "BUY" ? "SELL" : "BUY";
    const mark = await markPriceFor(market);
    const bound =
      side === "BUY"
        ? applyBps(mark, config.arcusSlippageBps, 18)
        : applyBps(mark, -config.arcusSlippageBps, 18);
    const price =
      side === "BUY" ? floorToStep(bound, market.tickSize) : ceilToStep(bound, market.tickSize);

    const quantity = floorToStep(leg.size, market.stepSize);
    if (compareDecimal(quantity, "0") <= 0) {
      throw new Error(`Arcus leg size ${leg.size} floors to zero against step ${market.stepSize}`);
    }

    const closeEntry = await recordPending({
      positionId,
      type: "close",
      amount: toBaseUnits(leg.size, decimals).toString(),
      note: `reduce-only ${side} ${quantity} on ${market.arcusDisplayName}`,
    });

    const clientId = `c${positionId}`.slice(0, 36);

    // Same ordering rule as the open: subscribed first, then place.
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
        `Closing order did not fill (${outcome.status}${
          outcome.cancelReason ? `: ${outcome.cancelReason}` : ""
        })`,
      );
    }

    // --- 3. The WS fill is the final price --------------------------------
    finalMarkPrice = outcome.averagePrice;
    await markConfirmed(closeEntry.id, {
      arcusRequestId: outcome.orderId,
      note: `closed ${outcome.filledSize} @ ${outcome.averagePrice}`,
    });

    log.info("closing fill confirmed", {
      positionId,
      size: outcome.filledSize,
      price: outcome.averagePrice,
    });
  }

  // --- 4. Settle on-chain ------------------------------------------------
  if (!(await isClosed(positionToken))) {
    await closeOnChain({
      positionToken,
      finalMarkPrice: toBaseUnits(finalMarkPrice, 18),
      // `finalFunding` is signed and denominated in asset units, matching the
      // contract's `initialDeposit + pnl + funding`.
      finalFunding: toBaseUnits(finalFunding, decimals),
      wasLiquidated: options.wasLiquidated ?? false,
    });
  }

  // --- 5. Sweep and recycle the slot -------------------------------------
  try {
    await sweepSubaccount(slot);
    await releaseSlot(slot.id);
  } catch (error) {
    // The position is closed either way; leaving the slot allocated is the safe
    // failure, since recycling it with funds still on it would hand the balance
    // to the next user.
    log.error("sweep failed after close; slot left allocated for the reconciler", {
      positionId,
      slotId: slot.id,
      ...errorFields(error),
    });
  }

  await db.position.update({
    where: { id: positionId },
    data: { status: "closed", closedAt: new Date() },
  });

  log.info("position closed", { positionId, finalMarkPrice, finalFunding });
}
