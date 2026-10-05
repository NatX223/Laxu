import type { Address } from "viem";

import { db } from "../config/db";
import { closePosition as closeOnChain, currentMark, isClosed, tokenAccounting, tokenLeverage } from "../chain/writes";
import { config } from "../config/env";
import { notFound } from "../lib/errors";
import { startWorker } from "../lib/async";
import { createLogger, errorFields } from "../lib/logger";
import { fromPrice18, fromSize6 } from "../lib/units";
import { saveLedgerRequest } from "../venue/requests";
import { venue } from "../venue/types";
import { getSlotForPosition } from "./allocator";
import { withSlotLock } from "./float";
import { findEntryForLog, markConfirmed, recordPending } from "./ledger";
import { marketForPosition } from "./markets";
import { pushFreshFunding } from "./reporter";
import { pushClaims, runSettlement, SettlementRetryLater, settlementFor } from "./settlement";
import { closeSide, placeAndResolve } from "./venueOrders";

const log = createLogger("close-position");

/**
 * Closing a position: flatten on the venue -> `close(funding, wasLiquidated)`
 * on-chain -> settlement (withdraw, `settle()`, push claims -- settlement.ts).
 *
 * The venue close is a close IOC order (reduce-only by definition, clamped to
 * the position) for the whole venue size, repeated until flat. The contract
 * reads the final mark from the venue itself; the operator supplies only the
 * final cumulative funding, pushed fresh just before the close.
 *
 * Two ways in:
 *   - The creator calls `requestClose()` on the token. The contract enforces
 *     who may, and the indexer's CloseRequested handler calls straight here.
 *   - The venue liquidated the position (reporter.ts). `close(..., true)` needs
 *     no request: the backend is only recording what the venue already did.
 *     Funding then stops at the last figure reported on-chain.
 *
 * The `settlements` row is written first and carries the final funding from
 * the moment it is known, so a restart after the venue leg is flat still
 * calls `close()` with the real value.
 */

/// Close attempts per run before leaving it to the resume job.
const CLOSE_ATTEMPTS = 3;

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
    /// The CloseRequested log that triggered this, recorded on the close
    /// ledger row as its dedupe key.
    event?: { txHash: string; logIndex: number };
  } = {},
): Promise<void> {
  await exclusive(positionId, () => closeAndSettle(positionId, options));
}

async function closeAndSettle(
  positionId: string,
  options: { wasLiquidated?: boolean; event?: { txHash: string; logIndex: number } },
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
    // --- 1-3. Flatten on the venue, unless a previous run already did -------
    if (settlement.finalFunding === null) {
      const final = await closeOnVenue(positionId, positionToken, options);
      const mark = await currentMark(positionToken).catch(() => null);
      settlement = await db.settlement.update({
        where: { positionId },
        data: { finalFunding: final.funding.toString(), finalMarkPrice: mark ? mark.price.toString() : null },
      });
    }

    // --- 4. Close on-chain: the contract reads the final mark itself --------
    const closeTxHash = await closeOnChain({
      positionToken,
      // Cumulative since open, as-is: the contract nets out `fundingSettled`.
      funding: BigInt(settlement.finalFunding ?? "0"),
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
 * whatever the proportional reduces left on the venue, then run the settlement
 * tail: recover the float from the token, sweep and free the slot.
 *
 * The settlements row is written before anything else, so from then on the
 * resume job retries whatever fails here. Safe to reach more than once:
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

/// Close of any venue position still open once every share is gone, so the
/// sweep frees all of the margin. Normally a no-op: a full exit already takes
/// the whole position.
async function flattenResidualLeg(positionId: string): Promise<void> {
  const position = await db.position.findUniqueOrThrow({ where: { id: positionId } });
  const slot = await getSlotForPosition(positionId);
  if (!slot) return;
  const market = await marketForPosition(position.market);
  const leg = await venue().getPosition(slot, market);
  if (!leg.exists) return;

  const entry = await recordPending({
    positionId,
    type: "close",
    amount: leg.size6.toString(),
    note: `residual flatten ${fromSize6(leg.size6)} on ${market.displaySymbol}`,
  });
  const outcome = await withSlotLock(slot.id, async () =>
    placeAndResolve(
      slot,
      market,
      {
        side: closeSide(position.direction),
        size6: leg.size6,
        leverage: await tokenLeverage(position.positionTokenAddress as Address),
      },
      (request) => saveLedgerRequest(entry.id, slot.id, request),
    ),
  );
  if (outcome.status === "unfilled" || outcome.status === "failed") {
    throw new Error(`residual flatten did not fill (${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ""})`);
  }
  await markConfirmed(entry.id, { venueOrderId: outcome.orderId, note: `flattened ${fromSize6(outcome.filledSize6)}` });
  log.info("residual venue position flattened", { positionId, size: fromSize6(outcome.filledSize6) });
}

/**
 * Flatten the venue position (if there is one) and return the funding
 * `close()` takes: the figure pushed fresh just before the close order, or --
 * with nothing left to close (liquidated, or flattened out of band) -- the
 * last one reported on-chain.
 */
async function closeOnVenue(
  positionId: string,
  positionToken: Address,
  options: { event?: { txHash: string; logIndex: number } },
): Promise<{ funding: bigint }> {
  const position = await db.position.findUniqueOrThrow({ where: { id: positionId } });
  const slot = await getSlotForPosition(positionId);
  if (!slot) throw new Error(`Position ${positionId} has no allocated slot`);
  const market = await marketForPosition(position.market);

  // --- 1. The live venue position ------------------------------------------
  let leg = await venue().getPosition(slot, market);
  if (!leg.exists) {
    log.warn("no open venue position to close; closing on-chain with the last reported funding", {
      positionId,
      market: market.displaySymbol,
    });
    if (options.event && !(await findEntryForLog(options.event.txHash, options.event.logIndex))) {
      await recordPending({
        positionId,
        type: "close",
        amount: "0",
        venueStatus: "confirmed",
        txHash: options.event.txHash,
        logIndex: options.event.logIndex,
        note: "close requested with no live venue position",
      });
    }
    return { funding: (await tokenAccounting(positionToken)).fundingAccrued };
  }

  // --- 2. Fresh funding: the final figure the close freezes -----------------
  const { funding } = await pushFreshFunding(position, slot, market);

  // A resumed close reuses the row its CloseRequested log already has.
  const existing = options.event ? await findEntryForLog(options.event.txHash, options.event.logIndex) : null;
  const closeEntry = existing ?? await recordPending({
    positionId,
    type: "close",
    amount: leg.size6.toString(),
    txHash: options.event?.txHash,
    logIndex: options.event?.logIndex,
    note: `close ${fromSize6(leg.size6)} on ${market.displaySymbol}`,
  });

  // --- 3. Close orders until flat, a fresh rq each ------------------------------
  let lastPrice = 0n;
  for (let attempt = 1; leg.exists; attempt += 1) {
    if (attempt > CLOSE_ATTEMPTS) {
      throw new Error(`venue position still ${fromSize6(leg.size6)} after ${CLOSE_ATTEMPTS} close attempts; resume job retries`);
    }
    const size6 = leg.size6;
    const outcome = await withSlotLock(slot.id, async () =>
      placeAndResolve(
        slot,
        market,
        { side: closeSide(position.direction), size6, leverage: await tokenLeverage(positionToken) },
        (request) => saveLedgerRequest(closeEntry.id, slot.id, request),
      ),
    );
    if (outcome.avgPrice18 > 0n) lastPrice = outcome.avgPrice18;
    log.info("close order outcome", {
      positionId,
      attempt,
      status: outcome.status,
      filled: fromSize6(outcome.filledSize6),
      reason: outcome.reason,
    });
    leg = await venue().getPosition(slot, market);
  }

  await markConfirmed(closeEntry.id, { note: `closed on ${market.displaySymbol}${lastPrice > 0n ? ` @ ${fromPrice18(lastPrice)}` : ""}` });
  return { funding };
}

// ---------------------------------------------------------------------------
// Resume job -- finishes closes and settlements a restart or a transient
// failure (e.g. a withdrawal rate limit) interrupted.
// ---------------------------------------------------------------------------

/// A withdrawal can be rate-limited by the exchange; retry on this clock.
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
