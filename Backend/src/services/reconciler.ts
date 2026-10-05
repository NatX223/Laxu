import type { Address } from "viem";

import { db } from "../config/db";
import { config } from "../config/env";
import { assetDecimals } from "../chain/clients";
import { absDecimal, compareDecimal, fromBaseUnits, subtractDecimal } from "../lib/decimal";
import { alert, createLogger, errorFields } from "../lib/logger";
import { startWorker } from "../lib/async";
import { venue } from "../venue/types";
import { reclaimExpiredReservations, type SlotWithWallet } from "./allocator";
import { expectedMargin } from "./ledger";
import { retryFulfil, retryPendingRedeem } from "./margin";
import { marketForPosition } from "./markets";
import { resumeOpenRequests } from "./openPosition";
import { computeFundingTarget } from "./reporter";
import { savedRequest } from "./venueOrders";

const log = createLogger("reconciler");

/**
 * Periodic reconciliation -- finding state that drifted rather than state
 * that failed loudly:
 *
 *   1. For every allocated slot, compare the ledger's net collateral against
 *      what the venue holds, and alert on drift. Also flag an allocated slot
 *      whose venue position is gone with no close in flight (a missed
 *      liquidation).
 *   2. Flag free slots still holding money above their reserve (unswept).
 *   3. Sweep ledger entries stranded mid-flight: `pending` (looked up by its
 *      saved rq when it has one) and `confirmed` with no on-chain fulfil.
 *   4. Resume open-position requests left mid-flight.
 */

export interface ReconcileReport {
  checkedSlots: number;
  drifted: Array<{ positionId: string; expected: string; actual: string; drift: string }>;
  missedLiquidations: string[];
  unsweptSlots: string[];
  strandedPending: number;
  strandedConfirmed: number;
  reclaimedReservations: number;
  resumedOpenRequests: number;
}

async function closeInFlight(positionId: string): Promise<boolean> {
  const [entry, settlement] = await Promise.all([
    db.ledgerEntry.findFirst({
      where: { positionId, type: { in: ["close", "trigger_exit"] }, venueStatus: { in: ["pending", "confirmed"] } },
      select: { id: true },
    }),
    db.settlement.findUnique({ where: { positionId }, select: { positionId: true } }),
  ]);
  return entry !== null || settlement !== null;
}

export async function reconcileOnce(): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    checkedSlots: 0,
    drifted: [],
    missedLiquidations: [],
    unsweptSlots: [],
    strandedPending: 0,
    strandedConfirmed: 0,
    reclaimedReservations: 0,
    resumedOpenRequests: 0,
  };

  report.reclaimedReservations = await reclaimExpiredReservations();
  report.resumedOpenRequests = await resumeOpenRequests();

  const decimals = await assetDecimals();

  // --- 1. Drift and missed liquidations -------------------------------------
  const allocated = await db.subaccountSlot.findMany({
    where: { status: "allocated", positionId: { not: null } },
    include: { operatorWallet: true, position: true },
  });

  for (const slot of allocated) {
    report.checkedSlots += 1;
    const position = slot.position;
    if (!position?.positionTokenAddress || position.status !== "open") continue;

    try {
      const market = await marketForPosition(position.market);
      const venuePosition = await venue().getPosition(slot as SlotWithWallet, market);
      if (!venuePosition.exists && !(await closeInFlight(position.id))) {
        report.missedLiquidations.push(position.id);
        alert("allocated slot has no venue position and no close in flight (missed liquidation?)", {
          positionId: position.id,
          slotId: slot.id,
        });
        continue;
      }

      // What the venue holds, less the mark-to-market PnL the ledger cannot
      // know about: deposits net of fees and funding, comparable to the
      // ledger's money-in/money-out.
      const { terms } = await computeFundingTarget(position.positionTokenAddress as Address, slot as SlotWithWallet, market, {
        venuePosition,
      });
      const expected = fromBaseUnits(await expectedMargin(position.id), decimals);
      const actual = fromBaseUnits(terms.venueTotal - terms.pricePnL, decimals);
      const drift = subtractDecimal(actual, expected);

      if (compareDecimal(absDecimal(drift), config.reconcileDriftTolerance) > 0) {
        report.drifted.push({ positionId: position.id, expected, actual, drift });
        alert("ledger/venue margin drift", {
          positionId: position.id,
          slotId: slot.id,
          expected,
          actual,
          drift,
          venueTotal: fromBaseUnits(terms.venueTotal, decimals),
          tolerance: config.reconcileDriftTolerance,
        });
      }
    } catch (error) {
      log.error("drift check failed", { positionId: position.id, ...errorFields(error) });
    }
  }

  // --- 2. Unswept free slots -----------------------------------------------------
  const free = await db.subaccountSlot.findMany({
    where: { status: "free", perplAccountId: { not: null } },
    include: { operatorWallet: true },
  });
  for (const slot of free) {
    try {
      const balance = await venue().accountBalance(slot);
      if (balance > BigInt(slot.reserve)) {
        report.unsweptSlots.push(slot.id);
        alert("free slot holds money above its reserve (unswept)", {
          slotId: slot.id,
          balance: fromBaseUnits(balance, decimals),
          reserve: fromBaseUnits(BigInt(slot.reserve), decimals),
        });
      }
    } catch (error) {
      log.error("free-slot balance check failed", { slotId: slot.id, ...errorFields(error) });
    }
  }

  // --- 3. Stranded ledger entries -------------------------------------------
  const stranded = await db.ledgerEntry.findMany({
    where: {
      type: { in: ["margin_add", "margin_remove"] },
      OR: [{ venueStatus: "pending" }, { venueStatus: "confirmed", onchainFulfilledAt: null }],
      // Give an in-flight request room to finish before treating it as stuck.
      createdAt: { lt: new Date(Date.now() - config.reconcileIntervalMs) },
      // Fulfils revert once closed; settlement.ts closes those rows out.
      position: { status: "open" },
    },
    include: { position: { include: { subaccountSlot: { include: { operatorWallet: true } } } } },
  });

  for (const entry of stranded) {
    try {
      if (entry.venueStatus === "pending" && entry.type === "margin_remove") {
        // A redeem is retried every pass until its reduce fills.
        report.strandedPending += 1;
        await retryPendingRedeem(entry.id);
        continue;
      }
      if (entry.venueStatus === "pending") {
        report.strandedPending += 1;
        // What the venue says about its last order, when it has one on file.
        // Resolving the entry automatically would mean guessing the rest of
        // the flow, so it is surfaced for a human with the venue's answer.
        let orderOutcome: string | undefined;
        const slot = entry.position.subaccountSlot;
        const sent = savedRequest(entry);
        if (sent && slot) {
          const found = await marketForPosition(entry.position.market)
            .then((market) => venue().findOrderOutcome(slot, sent, market))
            .catch((error) => `lookup failed: ${String(error)}`);
          orderOutcome = typeof found === "string" ? found : `${found.status} ${found.filledSize6} @ ${found.avgPrice18}`;
        }
        alert("ledger entry stuck in pending", {
          entryId: entry.id,
          positionId: entry.positionId,
          type: entry.type,
          amount: entry.amount,
          requestId: entry.venueRequestId,
          orderOutcome,
          createdAt: entry.createdAt.toISOString(),
        });
        continue;
      }

      report.strandedConfirmed += 1;
      // The margin flow's own on-chain leg sorts it out -- fulfils if the
      // request is still pending, recognises a fulfil that already landed, or
      // (if the user cancelled) marks it cancelled and undoes the venue move.
      await retryFulfil(entry.id);
    } catch (error) {
      log.error("could not resolve stranded entry", { entryId: entry.id, ...errorFields(error) });
    }
  }

  log.info("reconciliation pass complete", {
    checkedSlots: report.checkedSlots,
    drifted: report.drifted.length,
    missedLiquidations: report.missedLiquidations.length,
    unsweptSlots: report.unsweptSlots.length,
    strandedPending: report.strandedPending,
    strandedConfirmed: report.strandedConfirmed,
    reclaimedReservations: report.reclaimedReservations,
    resumedOpenRequests: report.resumedOpenRequests,
  });

  return report;
}

export function startReconciler(): () => void {
  log.info("reconciler starting", { intervalMs: config.reconcileIntervalMs });
  return startWorker(
    "reconciler",
    config.reconcileIntervalMs,
    async () => {
      await reconcileOnce();
    },
    (error) => log.error("reconciliation pass threw", errorFields(error)),
  );
}
