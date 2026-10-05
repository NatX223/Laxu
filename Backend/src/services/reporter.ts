import type { Position } from "@prisma/client";
import type { Address } from "viem";

import {
  applyFunding,
  currentMark,
  isClosed,
  readPositionState,
  tokenAccounting,
  type TokenAccounting,
} from "../chain/writes";
import { db } from "../config/db";
import { config } from "../config/env";
import { startWorker } from "../lib/async";
import { createLogger, errorFields } from "../lib/logger";
import { PRICE_SCALE } from "../lib/units";
import { venue, type VenuePosition } from "../venue/types";
import type { SlotWithWallet } from "./allocator";
import { executeClose, settleEmptiedPosition } from "./closePosition";
import { marketForPosition, type ResolvedMarket } from "./markets";
import { ensureMissingLendingPools } from "./openPosition";
import { refreshPositionStats } from "./positionStats";
import { hasUnfinishedBatch, processTriggers, triggeredHolders } from "./triggers";

const log = createLogger("reporter");

/**
 * The funding reporter. The token reads its mark from the venue itself; the
 * one thing the backend still reports is cumulative funding, via
 * `applyFunding(funding, ts)`.
 *
 * "Funding" is computed by equity reconciliation (see {computeFundingTarget}):
 * whatever the slot actually holds on Perpl, less what the token's own formula
 * already accounts for. It therefore absorbs real funding AND trading fees --
 * the venue's truth, which anyone can recompute from public on-chain data.
 */

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

export interface FundingTerms {
  venueTotal: bigint;
  positionEquity: bigint;
  freeAboveReserve: bigint;
  capital: bigint;
  pricePnL: bigint;
  fundingSettled: bigint;
  mark18: bigint;
  markLive: boolean;
  target: bigint;
}

/**
 * The contract values a position as
 *   capital + pricePnL(mark) + (fundingAccrued - fundingSettled),
 * and we want that to equal what the slot really holds on Perpl:
 *
 *   venueTotal     = positionEquity + max(0, accountBalance - reserve)
 *   positionEquity = depositAsset + pnlAsset   (pnl already holds the funding premium:
 *                    docs/perpl-findings.md#v-adapter-277)
 *   pricePnL       = size x (mark - entry) / 1e18, negated for shorts
 *                    (token.size(), token.entryPrice(), token.currentMark() --
 *                    the same integer maths as PositionToken._computeValue)
 *   target         = venueTotal - capital - pricePnL + fundingSettled
 */
/// The target from its terms (pure; see the comment above for each term).
export function fundingTarget(params: {
  positionEquity: bigint;
  free: bigint;
  reserve: bigint;
  capital: bigint;
  size: bigint;
  entryPrice: bigint;
  mark: bigint;
  direction: string;
  fundingSettled: bigint;
}): { target: bigint; venueTotal: bigint; freeAboveReserve: bigint; pricePnL: bigint } {
  const freeAboveReserve = params.free > params.reserve ? params.free - params.reserve : 0n;
  const venueTotal = params.positionEquity + freeAboveReserve;
  let pricePnL = (params.size * (params.mark - params.entryPrice)) / PRICE_SCALE;
  if (params.direction === "short") pricePnL = -pricePnL;
  const target = venueTotal - params.capital - pricePnL + params.fundingSettled;
  return { target, venueTotal, freeAboveReserve, pricePnL };
}

/// Push when funding moved by max(pushMin, capital x pushBps / 1e4), or the
/// last push is at least `heartbeatSeconds` old. Otherwise not.
export function shouldPushFunding(params: {
  target: bigint;
  accrued: bigint;
  capital: bigint;
  pushMin: bigint;
  pushBps: number;
  ageSeconds: bigint;
  heartbeatSeconds: number;
}): boolean {
  const relative = (params.capital * BigInt(params.pushBps)) / 10_000n;
  const threshold = relative > params.pushMin ? relative : params.pushMin;
  return abs(params.target - params.accrued) >= threshold || params.ageSeconds >= BigInt(params.heartbeatSeconds);
}

export async function computeFundingTarget(
  positionToken: Address,
  slot: SlotWithWallet,
  market: ResolvedMarket,
  known: { venuePosition?: VenuePosition; accounting?: TokenAccounting } = {},
): Promise<{ target: bigint; terms: FundingTerms; accounting: TokenAccounting }> {
  const [venuePosition, free, accounting, mark] = await Promise.all([
    known.venuePosition ?? venue().getPosition(slot, market),
    venue().accountBalance(slot),
    known.accounting ?? tokenAccounting(positionToken),
    currentMark(positionToken),
  ]);
  const positionEquity = venuePosition.equityAsset;
  const { target, venueTotal, freeAboveReserve, pricePnL } = fundingTarget({
    positionEquity,
    free,
    reserve: BigInt(slot.reserve),
    capital: accounting.capital,
    size: accounting.size,
    entryPrice: accounting.entryPrice,
    mark: mark.price,
    direction: accounting.direction,
    fundingSettled: accounting.fundingSettled,
  });
  return {
    target,
    accounting,
    terms: {
      venueTotal,
      positionEquity,
      freeAboveReserve,
      capital: accounting.capital,
      pricePnL,
      fundingSettled: accounting.fundingSettled,
      mark18: mark.price,
      markLive: mark.live,
      target,
    },
  };
}

/// Positions whose first report after mint has had every term logged (for
/// Spec 03's verification), this process.
const termsLogged = new Set<string>();

async function pushFunding(positionId: string, positionToken: Address, target: bigint, lastFundingTimestamp: bigint): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const now = nowSeconds();
    const timestamp = now > lastFundingTimestamp ? now : lastFundingTimestamp + 1n;
    try {
      await applyFunding({ positionToken, funding: target, timestamp });
      return;
    } catch (error) {
      // Another push landed in the same second: re-read and go again once.
      if (attempt >= 2 || !/stale report/i.test(error instanceof Error ? error.message : String(error))) throw error;
      lastFundingTimestamp = (await tokenAccounting(positionToken)).lastFundingTimestamp;
      log.debug("funding push collided; retrying", { positionId });
    }
  }
}

/**
 * Compute the target and ALWAYS push it, so navPerShare() is current. Called
 * before every buy-in, redeem, trigger batch and close. Returns what was pushed.
 */
export async function pushFreshFunding(
  position: Pick<Position, "id" | "positionTokenAddress">,
  slot: SlotWithWallet,
  market: ResolvedMarket,
): Promise<{ funding: bigint; terms: FundingTerms }> {
  if (!position.positionTokenAddress) throw new Error(`Position ${position.id} has no token address`);
  const token = position.positionTokenAddress as Address;
  const { target, terms, accounting } = await computeFundingTarget(token, slot, market);
  logTermsOnce(position.id, terms);
  await pushFunding(position.id, token, target, accounting.lastFundingTimestamp);
  return { funding: target, terms };
}

function logTermsOnce(positionId: string, terms: FundingTerms): void {
  if (termsLogged.has(positionId)) return;
  termsLogged.add(positionId);
  log.info("funding reconciliation terms (first report since mint/boot)", { positionId, ...terms });
}

/// One NAV-history point per position per minute.
async function writeReport(positionId: string, positionToken: Address, funding: bigint): Promise<void> {
  const timestamp = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const existing = await db.positionReport.findUnique({
    where: { positionId_timestamp: { positionId, timestamp } },
    select: { id: true },
  });
  if (existing) return;
  const state = await readPositionState(positionToken);
  await db.positionReport.upsert({
    where: { positionId_timestamp: { positionId, timestamp } },
    create: {
      positionId,
      markPrice: state.markPrice.toString(),
      funding: funding.toString(),
      totalAssets: state.totalAssets.toString(),
      totalSupply: state.totalSupply.toString(),
      timestamp,
    },
    update: {},
  });
  await db.position.update({
    where: { id: positionId },
    data: { markPrice: state.markPrice.toString(), fundingAccrued: funding.toString() },
  });
}

/**
 * One tick, per allocated slot with an open position:
 *   1. the venue position is gone and no close of ours is in flight -> liquidated;
 *   2. push funding when it moved by max(FUNDING_PUSH_MIN, capital x
 *      FUNDING_PUSH_BPS / 1e4), or FUNDING_HEARTBEAT_SECONDS passed;
 *   3. one PositionReport (NAV history) row per minute;
 *   4. SL/TP triggers at the token's own currentMark();
 * then lending pools still missing, and the stats refresh.
 *
 * A single position failing does not block the rest -- the next tick retries.
 */
export async function runReportingTick(): Promise<void> {
  try {
    await ensureMissingLendingPools();
  } catch (error) {
    log.error("lending pool retry pass failed", errorFields(error));
  }

  const slots = await db.subaccountSlot.findMany({
    where: { status: "allocated" },
    include: { operatorWallet: true, position: true },
  });
  const pushMin = BigInt(config.fundingPushMin);

  for (const slot of slots) {
    const position = slot.position;
    if (!position || position.status !== "open" || !position.positionTokenAddress) continue;

    try {
      const positionToken = position.positionTokenAddress as Address;
      const market = await marketForPosition(position.market);
      const venuePosition = await venue().getPosition(slot, market);

      if (!venuePosition.exists) {
        await checkForLiquidation(slot, position);
        continue;
      }

      const { target, terms, accounting } = await computeFundingTarget(positionToken, slot, market, { venuePosition });
      logTermsOnce(position.id, terms);
      const age = nowSeconds() - accounting.lastFundingTimestamp;
      let funding = accounting.fundingAccrued;
      const push = shouldPushFunding({
        target,
        accrued: accounting.fundingAccrued,
        capital: accounting.capital,
        pushMin,
        pushBps: config.fundingPushBps,
        ageSeconds: age,
        heartbeatSeconds: config.fundingHeartbeatSeconds,
      });
      if (push) {
        await pushFunding(position.id, positionToken, target, accounting.lastFundingTimestamp);
        funding = target;
        log.info("funding applied", { positionId: position.id, funding: target.toString(), ageSeconds: age.toString() });
      }

      await writeReport(position.id, positionToken, funding).catch((error) =>
        log.warn("NAV history write failed", { positionId: position.id, ...errorFields(error) }),
      );

      const { price: mark18 } = await currentMark(positionToken);
      if ((await triggeredHolders(position, mark18)).length > 0 || (await hasUnfinishedBatch(position.id))) {
        await processTriggers({ position, slot, market, positionToken });
      }
    } catch (error) {
      log.error("reporting failed for position", { positionId: position.id, ...errorFields(error) });
    }
  }

  try {
    await refreshPositionStats();
  } catch (error) {
    log.error("position stats refresh failed", errorFields(error));
  }
}

/// The age of every open position's last funding push, seconds -- for /health.
export async function fundingAges(): Promise<Record<string, number | null>> {
  const positions = await db.position.findMany({
    where: { status: "open", positionTokenAddress: { not: null } },
    select: { id: true, positionTokenAddress: true },
  });
  const ages: Record<string, number | null> = {};
  await Promise.all(
    positions.map(async (position) => {
      try {
        const accounting = await tokenAccounting(position.positionTokenAddress as Address);
        ages[position.id] = Number(nowSeconds() - accounting.lastFundingTimestamp);
      } catch {
        ages[position.id] = null;
      }
    }),
  );
  return ages;
}

// ---------------------------------------------------------------------------
// Liquidation detection
// ---------------------------------------------------------------------------

/// A `close` ledger entry, an unfinished SL/TP batch, or a settlement row means
/// a close of ours is under way -- the venue position going to zero then is
/// expected, not a liquidation.
async function hasIntentionalCloseInProgress(positionId: string): Promise<boolean> {
  const [entry, settlement] = await Promise.all([
    db.ledgerEntry.findFirst({
      where: {
        positionId,
        OR: [
          { type: "close", venueStatus: { in: ["pending", "confirmed"] } },
          { type: "trigger_exit", venueStatus: { in: ["pending", "confirmed"] }, onchainFulfilledAt: null },
        ],
      },
      select: { id: true },
    }),
    db.settlement.findUnique({ where: { positionId }, select: { trigger: true } }),
  ]);
  return entry !== null || settlement !== null;
}

/// Several signals can fire for one liquidation (stream events, the tick);
/// only one runs the close.
const liquidating = new Set<string>();

/**
 * If the venue position is gone (on-chain) and no close of ours is in flight,
 * the venue liquidated it: close on-chain with `wasLiquidated: true`.
 * Idempotent, so every signal can call it freely.
 */
export async function checkForLiquidation(slot: SlotWithWallet, position: Position): Promise<void> {
  if (position.status !== "open" || liquidating.has(position.id)) return;
  liquidating.add(position.id);
  try {
    await liquidateIfGone(slot, position);
  } finally {
    liquidating.delete(position.id);
  }
}

async function liquidateIfGone(slot: SlotWithWallet, position: Position): Promise<void> {
  const market = await marketForPosition(position.market);
  if ((await venue().getPosition(slot, market)).exists) return;
  if (await hasIntentionalCloseInProgress(position.id)) return;
  // The last share left (SL/TP or redeem) and the token closed itself.
  if (position.positionTokenAddress && (await isClosed(position.positionTokenAddress as Address))) {
    await settleEmptiedPosition(position.id);
    return;
  }

  log.warn("venue position gone with no intentional close in flight; treating as liquidated", {
    positionId: position.id,
    slotId: slot.id,
    perplAccountId: slot.perplAccountId,
  });
  await executeClose(position.id, { wasLiquidated: true });
}

/**
 * Stream routing: a position event on `slotId`'s account that says the venue
 * liquidated / deleveraged / unwound it. Keyed by slot; events older than the
 * position (a previous occupant's) are skipped.
 */
export async function onStreamLiquidationSignal(
  slotId: string,
  detail: { venueMarketId?: number; atMs?: number },
): Promise<void> {
  const slot = await db.subaccountSlot.findUnique({
    where: { id: slotId },
    include: { operatorWallet: true, position: true },
  });
  const position = slot?.position;
  if (!slot || slot.status !== "allocated" || !position || position.status !== "open") return;
  if (detail.atMs !== undefined && position.openedAt && detail.atMs < position.openedAt.getTime()) return;
  if (detail.venueMarketId !== undefined) {
    const market = await db.market.findUnique({ where: { id: position.market.toLowerCase() } });
    if (market && market.venueMarketId !== detail.venueMarketId) return;
  }
  await checkForLiquidation(slot, position);
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
