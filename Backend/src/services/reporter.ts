import type { Position } from "@prisma/client";
import type { Address } from "viem";

import { getAccountTransferUpdates, getPositions } from "../arcus/client";
import { usdgDecimals } from "../chain/clients";
import { applyReport, getLastReport } from "../chain/writes";
import { db } from "../config/db";
import { config } from "../config/env";
import { startWorker } from "../lib/async";
import { isZeroDecimal, toBaseUnits } from "../lib/decimal";
import { createLogger, errorFields } from "../lib/logger";
import { credentialsFor, type SlotWithWallet } from "./allocator";
import { executeClose } from "./closePosition";
import { markPriceFor, requireMarket } from "./markets";
import { ensureMissingLendingPools } from "./openPosition";

const log = createLogger("reporter");

/// Push a report once price has moved this much (in bps of the last reported
/// mark) even if the heartbeat hasn't elapsed yet.
const DEVIATION_THRESHOLD_BPS = 100n; // 1%
const BPS_DENOMINATOR = 10_000n;
/// Push a report at least this often regardless of deviation, so
/// {LendingPool.freshOracle}'s MAX_REPORT_AGE (7 minutes) never trips on an
/// otherwise-quiet market.
const HEARTBEAT_SECONDS = 5 * 60;

/**
 * One tick: for every allocated slot with a live, open position, compare Arcus's
 * current mark price/funding against what's on-chain and push a fresh
 * {applyReport} when it's moved enough or gone stale enough. Same
 * deviation/heartbeat policy the CRE-based design used -- only the delivery
 * mechanism (a plain interval instead of a DON) has changed.
 *
 * A single position's Arcus/chain call failing does not block the rest of the
 * tick -- skip and let the next tick retry, same tolerance the reconciler
 * already applies elsewhere.
 */
export async function runReportingTick(): Promise<void> {
  const decimals = await usdgDecimals();

  // Every position gets its LendingPool straight after minting; this retries
  // any whose createPool failed, so Borrow is never disabled for long.
  try {
    await ensureMissingLendingPools();
  } catch (error) {
    log.error("lending pool retry pass failed", errorFields(error));
  }

  const slots = await db.subaccountSlot.findMany({
    where: { status: "allocated" },
    include: { operatorWallet: true, position: true },
  });

  for (const slot of slots) {
    const position = slot.position;
    if (!position || position.status !== "open" || !position.positionTokenAddress) continue;

    try {
      const positionToken = position.positionTokenAddress as Address;
      const market = await requireMarket(position.market);
      const credentials = credentialsFor(slot as SlotWithWallet);

      const openPositions = await getPositions(credentials.address, credentials.accountIndex);
      const leg = openPositions.find((entry) => entry.marketId === market.arcusMarketId);

      // Arcus's own risk engine decides liquidation, using maintenanceMarginFraction
      // -- Laxu never decides or executes it, only detects that the position
      // vanished and reflects it on-chain. A normal user-requested close also
      // ends with the leg gone, so that case is excluded first.
      if (!leg || isZeroDecimal(leg.size)) {
        if (await hasIntentionalCloseInProgress(position.id)) continue;
        await handleLiquidation(slot as SlotWithWallet, position);
        continue;
      }

      const markPrice = toBaseUnits(await markPriceFor(market), 18);
      const funding = toBaseUnits(leg.cumulativeFunding?.sinceOpen ?? "0", decimals);

      const lastReport = await getLastReport(positionToken);

      const deviationBps =
        lastReport.markPrice === 0n
          ? DEVIATION_THRESHOLD_BPS
          : (absBigInt(markPrice - lastReport.markPrice) * BPS_DENOMINATOR) / lastReport.markPrice;
      const heartbeatDue =
        Math.floor(Date.now() / 1000) - Number(lastReport.timestamp) >= HEARTBEAT_SECONDS;

      if (deviationBps < DEVIATION_THRESHOLD_BPS && !heartbeatDue) continue;

      await applyReport({
        positionToken,
        markPrice,
        funding,
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
      });

      log.info("report applied", { positionId: position.id, positionToken, markPrice: markPrice.toString() });
    } catch (error) {
      log.error("could not apply report for position", {
        positionId: position.id,
        ...errorFields(error),
      });
    }
  }
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/// A pending `close` ledger entry means requestClose/executeClose is already
/// mid-flight for this position -- see closePosition.ts's recordPending/
/// markConfirmed ordering. That, and only that, distinguishes a normal
/// user-requested close (Arcus leg also goes to zero) from an unexpected one.
async function hasIntentionalCloseInProgress(positionId: string): Promise<boolean> {
  const pending = await db.ledgerEntry.findFirst({
    where: { positionId, type: "close", arcusStatus: "pending" },
    select: { id: true },
  });
  return pending !== null;
}

/**
 * The Arcus leg vanished with no close of ours in flight -- Arcus's own risk
 * engine liquidated it. Settling on-chain reuses `executeClose` exactly as the
 * indexer's CloseRequested handler does, just with `wasLiquidated: true`:
 * closePosition.ts already knows how to settle at current mark when there is
 * no live leg left to unwind (this is that same "no open Arcus leg" branch),
 * sweep whatever collateral remains, and recycle the slot.
 */
async function handleLiquidation(slot: SlotWithWallet, position: Position): Promise<void> {
  log.warn("Arcus position vanished with no intentional close in flight; treating as liquidated", {
    positionId: position.id,
    accountIndex: slot.accountIndex,
  });

  // Best-effort audit trail only -- a liquidation shows up as its own
  // SEIZURE_PAYMENT entry on the transfer feed. Never blocks the settlement
  // below: the on-chain close is what actually matters, this is just logging.
  try {
    const credentials = credentialsFor(slot);
    const transfers = await getAccountTransferUpdates(credentials.address, credentials.accountIndex, {
      limit: 20,
    });
    const seizure = transfers.find((entry) => entry.type === "SEIZURE_PAYMENT");
    if (seizure) {
      log.info("liquidation seizure transfer found", {
        positionId: position.id,
        transferId: seizure.id,
        amount: seizure.amount,
      });
    }
  } catch (error) {
    log.error("could not fetch transfer history for liquidated position", {
      positionId: position.id,
      ...errorFields(error),
    });
  }

  await executeClose(position.id, { wasLiquidated: true });
}

export function startReportingJob(): () => void {
  log.info("reporter starting", { intervalMs: config.reporterIntervalMs });
  return startWorker(
    "reporter",
    config.reporterIntervalMs,
    runReportingTick,
    (error) => log.error("reporting tick threw", errorFields(error)),
  );
}
