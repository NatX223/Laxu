import type { Address } from "viem";

import { getPositions } from "../arcus/client";
import { usdgDecimals } from "../chain/clients";
import { applyReport, getLastReport } from "../chain/writes";
import { db } from "../config/db";
import { config } from "../config/env";
import { startWorker } from "../lib/async";
import { toBaseUnits } from "../lib/decimal";
import { createLogger, errorFields } from "../lib/logger";
import { credentialsFor, type SlotWithWallet } from "./allocator";
import { markPriceFor, requireMarket } from "./markets";

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

      const markPrice = toBaseUnits(await markPriceFor(market), 18);
      const funding = toBaseUnits(leg?.cumulativeFunding?.sinceOpen ?? "0", decimals);

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

export function startReportingJob(): () => void {
  log.info("reporter starting", { intervalMs: config.reporterIntervalMs });
  return startWorker(
    "reporter",
    config.reporterIntervalMs,
    runReportingTick,
    (error) => log.error("reporting tick threw", errorFields(error)),
  );
}
