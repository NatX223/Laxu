import type { Address } from "viem";

import { getPositions, placeOrder } from "../arcus/client";
import { isLongSide } from "../arcus/types";
import { db } from "../config/db";
import { closePosition as closeOnChain, getLastReport, isClosed } from "../chain/writes";
import {
  applyBps,
  ceilToStep,
  compareDecimal,
  floorToStep,
  isZeroDecimal,
} from "../lib/decimal";
import { config } from "../config/env";
import { notFound } from "../lib/errors";
import { startWorker } from "../lib/async";
import { createLogger, errorFields } from "../lib/logger";
import { toPrice18, toSize6, toUsdg6 } from "../lib/units";
import { getArcusStream } from "./arcusStream";
import { credentialsFor, getSlotForPosition } from "./allocator";
import { markConfirmed, recordPending } from "./ledger";
import { markPriceFor, requireMarket } from "./markets";
import { clientIdFor, placeMarketOrder } from "./orders";
import { pushClaims, runSettlement, SettlementRetryLater, settlementFor } from "./settlement";

const log = createLogger("close-position");

/**
 * Closing a position: close on Arcus -> `close()` on-chain -> settlement
 * (withdraw, `settle()`, push claims -- see settlement.ts).
 *
 * Arcus has no dedicated close endpoint, so the real close is a reduce-only
 * MARKET order on the opposite side, sized to match the open position exactly.
 * The final price comes from the WS fill, same as the open, and only then does
 * the on-chain `close()` land.
 *
 * Two ways in:
 *   - The creator calls `requestClose()` on the token. The contract enforces
 *     who may (creator, holding 100% of supply, no deposit pending), and the
 *     indexer's CloseRequested handler calls straight into here.
 *   - Arcus liquidated the leg (reporter.ts). `close(..., true)` needs no
 *     request: the backend is only recording what Arcus already did. The final
 *     price is the liquidation fill's; funding is the last reported figure.
 *
 * The `settlements` row is written first and carries the final price/funding
 * from the moment they are known, so a restart after the fill (when the leg is
 * already gone) still calls `close()` with the real values.
 */

/// One close/settle per position at a time in this process: the indexer, the
/// liquidation triggers and the resume job can all reach the same position.
const inFlight = new Set<string>();

async function exclusive(positionId: string, task: () => Promise<void>): Promise<void> {
  if (inFlight.has(positionId)) {
    log.debug("close/settle already running for position", { positionId });
    return;
  }
  inFlight.add(positionId);
  try {
    await task();
  } finally {
    inFlight.delete(positionId);
  }
}

export async function executeClose(
  positionId: string,
  options: {
    wasLiquidated?: boolean;
    /// The liquidation fill's price, human decimal. Falls back to the mark.
    finalPrice?: string;
    /// The CloseRequested log that triggered this, recorded on the close
    /// ledger row as its dedupe key.
    event?: { txHash: string; logIndex: number };
  } = {},
): Promise<void> {
  await exclusive(positionId, () => closeAndSettle(positionId, options));
}

async function closeAndSettle(
  positionId: string,
  options: { wasLiquidated?: boolean; finalPrice?: string; event?: { txHash: string; logIndex: number } },
): Promise<void> {
  const position = await db.position.findUnique({ where: { id: positionId } });
  if (!position) throw notFound(`Position ${positionId} not found`);
  if (!position.positionTokenAddress) throw new Error(`Position ${positionId} has no token address`);
  if (position.status === "settled") return;

  const positionToken = position.positionTokenAddress as Address;
  const wasLiquidated = options.wasLiquidated ?? false;

  let settlement =
    (await settlementFor(positionId)) ??
    (await db.settlement.create({
      data: { positionId, trigger: wasLiquidated ? "liquidation" : "creator_close" },
    }));

  if (!(await isClosed(positionToken))) {
    // --- 1-3. Unwind on Arcus, unless a previous run already did -----------
    if (settlement.finalMarkPrice === null) {
      const final = await closeOnArcus(positionId, positionToken, options);
      settlement = await db.settlement.update({
        where: { positionId },
        data: { finalMarkPrice: final.mark18.toString(), finalFunding: final.funding6.toString() },
      });
    }

    // --- 4. Close on-chain ------------------------------------------------
    const closeTxHash = await closeOnChain({
      positionToken,
      finalMarkPrice: BigInt(settlement.finalMarkPrice as string),
      // Cumulative since open, as-is: the contract nets out `fundingSettled`.
      finalFunding: BigInt(settlement.finalFunding ?? "0"),
      wasLiquidated: settlement.trigger === "liquidation",
    });
    await db.settlement.update({ where: { positionId }, data: { closeTxHash, status: "withdrawing" } });
  }

  await db.position.updateMany({
    where: { id: positionId, status: "open" },
    data: { status: "closed", closedAt: new Date(), liquidated: settlement.trigger === "liquidation" },
  });
  log.info("position closed on-chain; settling", { positionId, trigger: settlement.trigger });

  // --- 5. Withdraw, settle, push claims --------------------------------------
  await runSettlement(positionId);
}

/**
 * The last share left through an SL/TP exit or a redeem, and the token closed
 * and settled itself at zero (`_closeIfEmpty`) -- no close() of ours. Flatten
 * whatever the proportional reduces left on Arcus, then run the settlement
 * tail: recover the float from the token, sweep and free the slot.
 *
 * The settlements row is written before anything else, so from then on the
 * resume job retries whatever fails here. Safe to reach more than once (the
 * indexer's Settled handler, the trigger batch, the liquidation check):
 * every step below is idempotent.
 */
export async function settleEmptiedPosition(positionId: string): Promise<void> {
  const position = await db.position.findUnique({ where: { id: positionId } });
  if (!position?.positionTokenAddress || position.status === "settled") return;
  if (!(await isClosed(position.positionTokenAddress as Address))) return;
  await db.settlement.upsert({
    where: { positionId },
    create: { positionId, trigger: "creator_close", status: "withdrawing" },
    update: {},
  });

  await exclusive(positionId, async () => {
    log.info("position emptied by its last exit; settling", { positionId });

    await flattenResidualLeg(positionId);
    await db.position.updateMany({
      where: { id: positionId, status: "open" },
      data: { status: "closed", closedAt: new Date() },
    });
    await runSettlement(positionId);
  });
}

/// Reduce-only close of any leg still open once every share is gone, so the
/// sweep frees all of the margin. Normally a no-op: a full exit already takes
/// the whole leg.
async function flattenResidualLeg(positionId: string): Promise<void> {
  const position = await db.position.findUniqueOrThrow({ where: { id: positionId } });
  const slot = await getSlotForPosition(positionId);
  if (!slot) return;
  const market = await requireMarket(position.market);
  const credentials = credentialsFor(slot);
  const leg = (await getPositions(credentials.address, credentials.accountIndex)).find(
    (entry) => entry.marketId === market.arcusMarketId,
  );
  if (!leg || isZeroDecimal(leg.size)) return;

  const quantity = floorToStep(leg.size, market.stepSize);
  if (compareDecimal(quantity, "0") <= 0 || compareDecimal(quantity, market.minOrderSize) < 0) {
    log.warn("residual Arcus leg below the minimum order size; left for the sweep", { positionId, size: leg.size });
    return;
  }
  const outcome = await placeMarketOrder({
    credentials,
    market,
    side: isLongSide(leg.side) ? "SELL" : "BUY",
    quantity,
    reduceOnly: true,
    clientId: clientIdFor("f", positionId),
  });
  if (outcome.unfilled) throw new Error(`residual flatten did not fill (${outcome.status})`);
  log.info("residual Arcus leg flattened", { positionId, size: outcome.filledSize, price: outcome.averagePrice });
}

/**
 * Close the Arcus leg (if there is one) and return the values `close()` takes:
 * the final price (1e18) and cumulative funding since open (USDG 6dp).
 */
async function closeOnArcus(
  positionId: string,
  positionToken: Address,
  options: { finalPrice?: string; event?: { txHash: string; logIndex: number } },
): Promise<{ mark18: bigint; funding6: bigint }> {
  const position = await db.position.findUniqueOrThrow({ where: { id: positionId } });
  const slot = await getSlotForPosition(positionId);
  if (!slot) throw new Error(`Position ${positionId} has no allocated slot`);

  const market = await requireMarket(position.market);
  const credentials = credentialsFor(slot);

  // --- 1. Find the live leg on Arcus -------------------------------------
  const openPositions = await getPositions(credentials.address, credentials.accountIndex);
  const leg = openPositions.find((entry) => entry.marketId === market.arcusMarketId);

  if (!leg || isZeroDecimal(leg.size)) {
    // Nothing left to unwind -- liquidated, or already flattened out of band.
    // The liquidation fill's price when we have it; funding stops at the last
    // figure reported on-chain.
    const price = options.finalPrice ?? (await markPriceFor(market));
    log.warn("no open Arcus leg to close; closing on-chain at the last known price", {
      positionId,
      marketId: market.arcusMarketId,
      price,
      fromFill: Boolean(options.finalPrice),
    });
    if (options.event) {
      await recordPending({
        positionId,
        type: "close",
        amount: "0",
        arcusStatus: "confirmed",
        txHash: options.event.txHash,
        logIndex: options.event.logIndex,
        note: "close requested with no live Arcus leg",
      });
    }
    return { mark18: toPrice18(price), funding6: (await getLastReport(positionToken)).funding };
  }

  // Snapshot taken just before closing: the close order resets it.
  const funding6 = toUsdg6(leg.cumulativeFunding?.sinceOpen ?? "0");

  // --- 2. Reduce-only, opposite side, sized to match exactly ------------
  const side = isLongSide(leg.side) ? "SELL" : "BUY";
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
    amount: toSize6(leg.size).toString(),
    txHash: options.event?.txHash,
    logIndex: options.event?.logIndex,
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
  await markConfirmed(closeEntry.id, {
    arcusRequestId: outcome.orderId,
    note: `closed ${outcome.filledSize} @ ${outcome.averagePrice}`,
  });
  log.info("closing fill confirmed", {
    positionId,
    size: outcome.filledSize,
    price: outcome.averagePrice,
  });

  return { mark18: toPrice18(outcome.averagePrice), funding6 };
}

// ---------------------------------------------------------------------------
// Resume job -- finishes closes and settlements a restart or a transient
// failure (e.g. Arcus still winding down a liquidation) interrupted.
// ---------------------------------------------------------------------------

/// Arcus rejects withdrawals while it winds down a liquidated account; retry
/// on this clock rather than hammering the heavyweight withdraw queue.
const RETRY_AFTER_ERROR_MS = 5 * 60_000;
/// Give a close that is running right now room to finish before resuming it.
const IN_FLIGHT_GRACE_MS = 2 * 60_000;

export async function resumeSettlements(): Promise<void> {
  const now = Date.now();
  const rows = await db.settlement.findMany({
    where: {
      OR: [
        { status: { not: "settled" } },
        { claimsPushedAt: null },
        // Settled, but the sweep failed and the slot is still held.
        { position: { subaccountSlot: { isNot: null } } },
      ],
    },
  });

  for (const row of rows) {
    const idleMs = now - row.updatedAt.getTime();
    if (idleMs < (row.error ? RETRY_AFTER_ERROR_MS : IN_FLIGHT_GRACE_MS)) continue;

    try {
      if (row.status === "settled") {
        const slot = await getSlotForPosition(row.positionId);
        if (slot) await exclusive(row.positionId, () => runSettlement(row.positionId));
        else if (!row.claimsPushedAt) await pushClaims(row.positionId);
      } else {
        await executeClose(row.positionId, { wasLiquidated: row.trigger === "liquidation" });
      }
    } catch (error) {
      const retryLater = error instanceof SettlementRetryLater;
      log[retryLater ? "warn" : "error"]("settlement resume attempt failed", {
        positionId: row.positionId,
        status: row.status,
        ...errorFields(error),
      });
    }
  }
}

export function startSettlementJob(): () => void {
  log.info("settlement job starting", { intervalMs: config.settlementIntervalMs });
  return startWorker(
    "settlement",
    config.settlementIntervalMs,
    resumeSettlements,
    (error) => log.error("settlement tick threw", errorFields(error)),
  );
}
