import type { Position } from "@prisma/client";
import type { Address } from "viem";

import { getAccountTransferUpdates, getPositions } from "../arcus/client";
import type { ArcusCredentials, ArcusFill, ArcusPosition } from "../arcus/types";
import { applyReport, getLastReport, isClosed } from "../chain/writes";
import { db } from "../config/db";
import { config } from "../config/env";
import { startWorker } from "../lib/async";
import { isZeroDecimal } from "../lib/decimal";
import { createLogger, errorFields } from "../lib/logger";
import { fromArcusPositionRow, toPrice18 } from "../lib/units";
import { credentialsFor, type SlotWithWallet } from "./allocator";
import type { AccountKey } from "./arcusStream";
import { executeClose, settleEmptiedPosition } from "./closePosition";
import { markPriceFor, requireMarket, type ResolvedMarket } from "./markets";
import { ensureMissingLendingPools } from "./openPosition";
import { refreshPositionStats } from "./positionStats";
import { hasUnfinishedBatch, processTriggers, triggeredHolders } from "./triggers";

const log = createLogger("reporter");

/// Push a report once price has moved this much (in bps of the last reported
/// mark) even if the heartbeat hasn't elapsed yet.
const DEVIATION_THRESHOLD_BPS = 100n; // 1%
const BPS_DENOMINATOR = 10_000n;
/// Push a report at least this often regardless of deviation, so
/// {LendingPool.freshOracle}'s MAX_REPORT_AGE (7 minutes) never trips on an
/// otherwise-quiet market.
const HEARTBEAT_SECONDS = 5 * 60;

/// The live Arcus leg for a market on a subaccount, if any.
export async function findLeg(credentials: ArcusCredentials, arcusMarketId: number): Promise<ArcusPosition | undefined> {
  const openPositions = await getPositions(credentials.address, credentials.accountIndex);
  const leg = openPositions.find((entry) => entry.marketId === arcusMarketId);
  return leg && !isZeroDecimal(leg.size) ? leg : undefined;
}

/**
 * `applyReport(mark18, funding6, ts)`:
 *   mark18   = toPrice18(markPx)
 *   funding6 = toUsdg6(cumulativeFunding.sinceOpen), as-is -- the cumulative
 *              total; the contract subtracts `fundingSettled` itself.
 *
 * `ts` must be strictly greater than the token's last report, which a report
 * pushed earlier in the same second would otherwise collide with.
 */
async function report(positionToken: Address, mark18: bigint, funding6: bigint, lastTimestamp: bigint): Promise<void> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  await applyReport({
    positionToken,
    markPrice: mark18,
    funding: funding6,
    timestamp: now > lastTimestamp ? now : lastTimestamp + 1n,
  });
}

/**
 * Step 1 of every buy-in and redeem: push the current mark and funding so the
 * contract's navPerShare() -- the price the fulfil settles at -- is current.
 * Returns the mark used.
 */
export async function pushFreshReport(params: {
  positionToken: Address;
  credentials: ArcusCredentials;
  market: ResolvedMarket;
}): Promise<{ mark18: bigint; leg: ArcusPosition | undefined }> {
  const mark = await markPriceFor(params.market);
  const leg = await findLeg(params.credentials, params.market.arcusMarketId);
  const last = await getLastReport(params.positionToken);
  // No live leg (mid-liquidation): keep the last reported funding.
  const funding6 = leg ? fromArcusPositionRow(leg, mark).funding6 : last.funding;
  const mark18 = toPrice18(mark);
  await report(params.positionToken, mark18, funding6, last.timestamp);
  return { mark18, leg };
}

/**
 * One tick: for every allocated slot with a live, open position, compare Arcus's
 * current mark price/funding against what's on-chain and push a fresh
 * {applyReport} when it's moved enough or gone stale enough -- or when the
 * fresh mark crosses some holder's stop loss / take profit, so triggers run
 * every minute rather than waiting for 1% of movement. Triggers are then
 * evaluated against the stored mark (services/triggers.ts).
 *
 * A single position's Arcus/chain call failing does not block the rest of the
 * tick -- skip and let the next tick retry.
 */
export async function runReportingTick(): Promise<void> {
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
      const leg = await findLeg(credentials, market.arcusMarketId);

      // Fallback liquidation trigger: the stream's liquidation-marked fill is
      // the main one (see onLiquidationFill). A leg that vanished with no close
      // of ours in flight means Arcus's risk engine closed it.
      if (!leg) {
        await checkForLiquidation(slot as SlotWithWallet, position);
        continue;
      }

      const mark = await markPriceFor(market);
      const { funding6 } = fromArcusPositionRow(leg, mark);
      const mark18 = toPrice18(mark);
      const lastReport = await getLastReport(positionToken);

      const deviationBps =
        lastReport.markPrice === 0n
          ? DEVIATION_THRESHOLD_BPS
          : (absBigInt(mark18 - lastReport.markPrice) * BPS_DENOMINATOR) / lastReport.markPrice;
      const heartbeatDue = Math.floor(Date.now() / 1000) - Number(lastReport.timestamp) >= HEARTBEAT_SECONDS;
      const triggerDue = (await triggeredHolders(position, mark18)).length > 0;

      if (deviationBps >= DEVIATION_THRESHOLD_BPS || heartbeatDue || triggerDue) {
        await report(positionToken, mark18, funding6, lastReport.timestamp);
        log.info("report applied", { positionId: position.id, positionToken, markPrice: mark18.toString() });
      }

      if (triggerDue || (await hasUnfinishedBatch(position.id))) {
        await processTriggers({ position, slot: slot as SlotWithWallet, market, positionToken });
      }
    } catch (error) {
      log.error("could not apply report for position", { positionId: position.id, ...errorFields(error) });
    }
  }

  // Same cron, straight after: metrics for discovery / position / portfolio.
  try {
    await refreshPositionStats();
  } catch (error) {
    log.error("position stats refresh failed", errorFields(error));
  }
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/// A `close` ledger entry means requestClose/executeClose is under way (or
/// done) for this position. That, and only that, distinguishes a normal close
/// (the Arcus leg also goes to zero, and a FLAT row arrives) from an
/// unexpected one. Confirmed counts too: the entry flips to confirmed at the
/// fill, before the on-chain close lands.
/// An SL/TP batch that has not finished on-chain counts too: a batch exiting
/// every holder takes the whole leg to zero before the token closes itself.
async function hasIntentionalCloseInProgress(positionId: string): Promise<boolean> {
  const [entry, settlement] = await Promise.all([
    db.ledgerEntry.findFirst({
      where: {
        positionId,
        OR: [
          { type: "close", arcusStatus: { in: ["pending", "confirmed"] } },
          { type: "trigger_exit", arcusStatus: { in: ["pending", "confirmed"] }, onchainFulfilledAt: null },
        ],
      },
      select: { id: true },
    }),
    db.settlement.findUnique({ where: { positionId }, select: { trigger: true } }),
  ]);
  return entry !== null || settlement !== null;
}

/// Several triggers can fire for one liquidation (fill marker, FLAT row,
/// reporter tick); only one runs the close.
const liquidating = new Set<string>();

/**
 * If the position's Arcus leg is gone and no close of ours is in flight,
 * Arcus liquidated it: settle on-chain with `wasLiquidated: true`. Idempotent
 * -- a live leg or an intentional close makes it a no-op -- so every trigger
 * (stream fill marker, FLAT row, reporter tick) can call it freely.
 */
export async function checkForLiquidation(slot: SlotWithWallet, position: Position, fill?: ArcusFill): Promise<void> {
  if (position.status !== "open" || liquidating.has(position.id)) return;
  liquidating.add(position.id);
  try {
    await liquidateIfGone(slot, position, fill);
  } finally {
    liquidating.delete(position.id);
  }
}

async function liquidateIfGone(slot: SlotWithWallet, position: Position, fill?: ArcusFill): Promise<void> {
  const market = await requireMarket(position.market);
  if (await findLeg(credentialsFor(slot), market.arcusMarketId)) return;
  if (await hasIntentionalCloseInProgress(position.id)) return;
  // The last share left (SL/TP or redeem) and the token closed itself; the
  // leg is gone because we closed it, not Arcus.
  if (position.positionTokenAddress && (await isClosed(position.positionTokenAddress as Address))) {
    await settleEmptiedPosition(position.id);
    return;
  }

  log.warn("Arcus position gone with no intentional close in flight; treating as liquidated", {
    positionId: position.id,
    accountIndex: slot.accountIndex,
  });

  // Best-effort audit trail only -- a liquidation shows up as its own
  // SEIZURE_PAYMENT entry on the transfer feed.
  try {
    const transfers = await getAccountTransferUpdates(slot.operatorWallet.address, slot.accountIndex, { limit: 20 });
    const seizure = transfers.find((entry) => entry.type === "SEIZURE_PAYMENT");
    if (seizure) {
      log.info("liquidation seizure transfer found", { positionId: position.id, transferId: seizure.id, amount: seizure.amount });
    }
  } catch (error) {
    log.error("could not fetch transfer history for liquidated position", { positionId: position.id, ...errorFields(error) });
  }

  // close(..., true) at the liquidation fill's price, then settle and push
  // claims (closePosition.ts -> settlement.ts).
  await executeClose(position.id, { wasLiquidated: true, finalPrice: fill?.liquidation ? fill.price : undefined });
}

/**
 * Stream routing for a liquidation-marked fill or an unexpected FLAT row.
 * Frames may not carry the accountIndex (-1 then), so every allocated slot of
 * that wallet trading the fill's market is checked; each check is a no-op
 * unless the leg is really gone.
 */
export async function onStreamLiquidationSignal(
  account: AccountKey,
  detail: { marketId?: number; fill?: ArcusFill },
): Promise<void> {
  const slots = await db.subaccountSlot.findMany({
    where: {
      status: "allocated",
      operatorWallet: { address: { equals: account.address, mode: "insensitive" } },
      ...(account.accountIndex >= 0 ? { accountIndex: account.accountIndex } : {}),
    },
    include: { operatorWallet: true, position: true },
  });

  for (const slot of slots) {
    const position = slot.position;
    if (!position || position.status !== "open") continue;
    // A snapshot replays old fills -- including a previous occupant's.
    if (detail.fill && position.openedAt && detail.fill.createdAt / 1000 < position.openedAt.getTime()) continue;
    if (detail.marketId !== undefined) {
      const market = await db.market.findUnique({ where: { id: position.market.toLowerCase() } });
      if (market && market.arcusMarketId !== detail.marketId) continue;
    }
    try {
      await checkForLiquidation(slot as SlotWithWallet, position, detail.fill);
    } catch (error) {
      log.error("stream-triggered liquidation check failed", { positionId: position.id, ...errorFields(error) });
    }
  }
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
