import { getAccount } from "../arcus/client";
import { db } from "../config/db";
import { config } from "../config/env";
import { usdgDecimals } from "../chain/clients";
import { absDecimal, compareDecimal, subtractDecimal } from "../lib/decimal";
import { alert, createLogger, errorFields } from "../lib/logger";
import { startWorker } from "../lib/async";
import { reclaimExpiredReservations } from "./allocator";
import { expectedMargin } from "./ledger";
import { retryFulfil } from "./margin";
import { resumeOpenRequests } from "./openPosition";
import { fromBaseUnits as toDollars } from "../lib/decimal";

const log = createLogger("reconciler");

/**
 * Periodic reconciliation.
 *
 * Two jobs, both about finding state that drifted rather than state that failed
 * loudly:
 *
 *   1. For every allocated slot, compare what the ledger says the position
 *      should be holding against Arcus's actual equity, and alert on drift.
 *
 *   2. Sweep ledger entries stranded mid-flight. A `pending` row means the
 *      process died between writing the row and hearing back from Arcus; a
 *      `confirmed` row with no on-chain fulfilment means it died between the two
 *      legs. Both resolve the same way the cancellation race does.
 *
 *   3. Resume open-position requests left mid-flight (restart, a slow Arcus
 *      credit, createPosition failing, a refund waiting on its withdrawal).
 */

export interface ReconcileReport {
  checkedSlots: number;
  drifted: Array<{ positionId: string; expected: string; actual: string; drift: string }>;
  strandedPending: number;
  strandedConfirmed: number;
  reclaimedReservations: number;
  resumedOpenRequests: number;
}

export async function reconcileOnce(): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    checkedSlots: 0,
    drifted: [],
    strandedPending: 0,
    strandedConfirmed: 0,
    reclaimedReservations: 0,
    resumedOpenRequests: 0,
  };

  report.reclaimedReservations = await reclaimExpiredReservations();
  report.resumedOpenRequests = await resumeOpenRequests();

  const decimals = await usdgDecimals();

  // --- 1. Margin drift ----------------------------------------------------
  const allocated = await db.subaccountSlot.findMany({
    where: { status: "allocated", positionId: { not: null } },
    include: { operatorWallet: true },
  });

  for (const slot of allocated) {
    report.checkedSlots += 1;
    const positionId = slot.positionId as string;

    try {
      const account = await getAccount(slot.operatorWallet.address, slot.accountIndex);
      if (!account) {
        alert("allocated slot has no Arcus account", {
          positionId,
          slotId: slot.id,
          accountIndex: slot.accountIndex,
        });
        continue;
      }

      const expected = toDollars(await expectedMargin(positionId), decimals);
      // Equity, not free collateral: the ledger tracks capital committed to the
      // position, which sits in the isolated leg once the order fills.
      const actual = account.equity;
      const drift = subtractDecimal(actual, expected);

      if (compareDecimal(absDecimal(drift), config.reconcileDriftTolerance) > 0) {
        report.drifted.push({ positionId, expected, actual, drift });
        alert("ledger/Arcus margin drift", {
          positionId,
          slotId: slot.id,
          accountIndex: slot.accountIndex,
          expected,
          actual,
          drift,
          tolerance: config.reconcileDriftTolerance,
        });
      }
    } catch (error) {
      log.error("drift check failed", { positionId, ...errorFields(error) });
    }
  }

  // --- 2. Stranded ledger entries -----------------------------------------
  const stranded = await db.ledgerEntry.findMany({
    where: {
      type: { in: ["margin_add", "margin_remove"] },
      OR: [
        { arcusStatus: "pending" },
        { arcusStatus: "confirmed", onchainFulfilledAt: null },
      ],
      // Give an in-flight request room to finish before treating it as stuck.
      createdAt: { lt: new Date(Date.now() - config.reconcileIntervalMs) },
    },
    include: { position: true },
  });

  for (const entry of stranded) {
    try {
      if (entry.arcusStatus === "pending") {
        report.strandedPending += 1;
        // Nothing is known to have moved on Arcus. Resolving this automatically
        // would mean guessing; the transfer feed is the authority, so it is
        // surfaced for a human rather than reversed blind.
        alert("ledger entry stuck in pending", {
          entryId: entry.id,
          positionId: entry.positionId,
          type: entry.type,
          amount: entry.amount,
          createdAt: entry.createdAt.toISOString(),
        });
        continue;
      }

      report.strandedConfirmed += 1;
      await resolveConfirmedButUnfulfilled(entry.id);
    } catch (error) {
      log.error("could not resolve stranded entry", { entryId: entry.id, ...errorFields(error) });
    }
  }

  log.info("reconciliation pass complete", {
    checkedSlots: report.checkedSlots,
    drifted: report.drifted.length,
    strandedPending: report.strandedPending,
    strandedConfirmed: report.strandedConfirmed,
    reclaimedReservations: report.reclaimedReservations,
    resumedOpenRequests: report.resumedOpenRequests,
  });

  return report;
}

/**
 * A `confirmed` entry with no on-chain fulfilment: margin moved on Arcus, but
 * the vault side never landed. The margin flow's own on-chain leg sorts it
 * out -- fulfils if the request is still pending, recognises a fulfil that
 * already landed, or (if the user cancelled) marks it cancelled and undoes the
 * Arcus move.
 */
async function resolveConfirmedButUnfulfilled(entryId: string): Promise<void> {
  await retryFulfil(entryId);
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
