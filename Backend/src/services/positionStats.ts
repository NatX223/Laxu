import type { Position } from "@prisma/client";
import type { Address } from "viem";

import { readPositionState, type OnChainPositionState } from "../chain/writes";
import { db } from "../config/db";
import { createLogger, errorFields } from "../lib/logger";
import { PRICE_SCALE, toFixedDecimals, toPrice18 } from "../lib/units";

const log = createLogger("position-stats");

/**
 * PositionStats -- one row per position, recomputed every minute straight
 * after the reporter tick (same cron). Discovery, the position page and the
 * portfolio read these rows instead of the chain.
 *
 * Every metric is defined once, in {derivePositionStats}, which is pure so it
 * can be tested on a fixture without a database or an RPC.
 */

const DAY_MS = 24 * 60 * 60_000;
const BPS = 10_000n;

export interface StatsInput {
  chain: Pick<
    OnChainPositionState,
    "size" | "markPrice" | "totalAssets" | "totalSupply" | "fundingAccrued" | "fundingSettled"
  >;
  open: boolean;
  /// Arcus's maintenanceMarginFraction for the market, decimal string.
  maintenanceMarginFraction: string;
  holdings: Array<{ address: string; balance: string }>;
  /// This position's LendingPool addresses: tokens held there belong to borrowers.
  poolAddresses: string[];
  borrowers: Array<{ address: string; collateralShares: string; debt: string }>;
  flows: Array<{ type: string; address: string; assets: string; feeAssets: string; timestamp: Date }>;
  now: Date;
}

export interface DerivedStats {
  navPerShare: bigint;
  totalAssets: bigint;
  totalSupply: bigint;
  pnlBps: number;
  markPrice: bigint;
  fundingNet: bigint;
  effectiveLeverage: string;
  holderCount: number;
  buyInVolume: bigint;
  buyInVolume24h: bigint;
  buyerCount24h: number;
  isAtRisk: boolean;
  isCollateralized: boolean;
}

/// NAV per share at 1e18. Genesis NAV is 1.0; buy-ins and redeems happen at NAV.
export function navOf(totalAssets: bigint, totalSupply: bigint): bigint {
  return totalSupply === 0n ? PRICE_SCALE : (totalAssets * PRICE_SCALE) / totalSupply;
}

/**
 * Distinct holders: addresses with a balance, minus the LendingPool contracts,
 * plus borrowers with collateral posted -- tokens in a pool still belong to
 * the borrower.
 */
export function holderAddresses(
  holdings: StatsInput["holdings"],
  poolAddresses: string[],
  borrowers: StatsInput["borrowers"],
): Set<string> {
  const pools = new Set(poolAddresses.map((a) => a.toLowerCase()));
  const holders = new Set<string>();
  for (const h of holdings) {
    const address = h.address.toLowerCase();
    if (BigInt(h.balance) > 0n && !pools.has(address)) holders.add(address);
  }
  for (const b of borrowers) {
    if (BigInt(b.collateralShares) > 0n) holders.add(b.address.toLowerCase());
  }
  return holders;
}

export function derivePositionStats(input: StatsInput): DerivedStats {
  const { chain } = input;
  const nav = navOf(chain.totalAssets, chain.totalSupply);
  const pnlBps = Number(((nav - PRICE_SCALE) * BPS) / PRICE_SCALE);

  // size6 x mark18 / 1e18 = notional in USDG 6dp.
  const notional6 = (chain.size * chain.markPrice) / PRICE_SCALE;
  const effectiveLeverage =
    chain.totalAssets > 0n ? toFixedDecimals((notional6 * 100n) / chain.totalAssets, 2, 2) : "0.00";

  // At Risk: equity / notional < 1.5 x MMF, i.e. within 50% of Arcus's
  // liquidation line. Compared at 1e18: 2 x ratio < 3 x MMF.
  const mmf18 = toPrice18(input.maintenanceMarginFraction || "0");
  const isAtRisk =
    input.open && notional6 > 0n && mmf18 > 0n && ((chain.totalAssets * PRICE_SCALE) / notional6) * 2n < mmf18 * 3n;

  const since = input.now.getTime() - DAY_MS;
  let buyInVolume = 0n;
  let buyInVolume24h = 0n;
  const buyers24h = new Set<string>();
  for (const flow of input.flows) {
    // Only third-party buy-ins count: top_up and open do not.
    if (flow.type !== "buy_in") continue;
    const gross = BigInt(flow.assets) + BigInt(flow.feeAssets);
    buyInVolume += gross;
    if (flow.timestamp.getTime() >= since) {
      buyInVolume24h += gross;
      buyers24h.add(flow.address.toLowerCase());
    }
  }

  return {
    navPerShare: nav,
    totalAssets: chain.totalAssets,
    totalSupply: chain.totalSupply,
    pnlBps,
    markPrice: chain.markPrice,
    fundingNet: chain.fundingAccrued - chain.fundingSettled,
    effectiveLeverage,
    holderCount: holderAddresses(input.holdings, input.poolAddresses, input.borrowers).size,
    buyInVolume,
    buyInVolume24h,
    buyerCount24h: buyers24h.size,
    isAtRisk,
    isCollateralized: input.borrowers.some((b) => BigInt(b.debt) > 0n),
  };
}

async function gather(position: Position, now: Date): Promise<StatsInput> {
  const token = (position.positionTokenAddress as string).toLowerCase();
  const [chain, market, holdings, pools, flows, settledPoint] = await Promise.all([
    readPositionState(token as Address),
    db.market.findUnique({ where: { id: position.market.toLowerCase() } }),
    db.holding.findMany({ where: { positionId: position.id } }),
    db.lendingPool.findMany({ where: { positionTokenAddress: token }, include: { borrowers: true } }),
    db.flow.findMany({ where: { positionId: position.id, type: "buy_in" } }),
    db.positionReport.findFirst({ where: { positionId: position.id, isFinal: true, provisional: false } }),
  ]);
  return {
    // Settled: claims burn supply towards zero, so the live ratio stops
    // meaning anything once the last holder is paid. Pin the numbers to the
    // settlement itself (recovered USDG / supply at settle).
    chain: settledPoint
      ? { ...chain, totalAssets: BigInt(settledPoint.totalAssets), totalSupply: BigInt(settledPoint.totalSupply) }
      : chain,
    open: position.status === "open" && !chain.closed,
    maintenanceMarginFraction: market?.maintenanceMarginFraction ?? "0",
    holdings,
    poolAddresses: pools.map((p) => p.poolAddress),
    borrowers: pools.flatMap((p) => p.borrowers),
    flows,
    now,
  };
}

export async function refreshStatsFor(position: Position, now = new Date()): Promise<DerivedStats> {
  const stats = derivePositionStats(await gather(position, now));
  const data = {
    navPerShare: stats.navPerShare.toString(),
    totalAssets: stats.totalAssets.toString(),
    totalSupply: stats.totalSupply.toString(),
    pnlBps: stats.pnlBps,
    markPrice: stats.markPrice.toString(),
    fundingNet: stats.fundingNet.toString(),
    effectiveLeverage: stats.effectiveLeverage,
    holderCount: stats.holderCount,
    buyInVolume: stats.buyInVolume.toString(),
    buyInVolume24h: stats.buyInVolume24h.toString(),
    buyerCount24h: stats.buyerCount24h,
    isAtRisk: stats.isAtRisk,
    isCollateralized: stats.isCollateralized,
  };
  await db.positionStats.upsert({ where: { positionId: position.id }, create: { positionId: position.id, ...data }, update: data });
  return stats;
}

/**
 * Every open position, plus closed ones that closed recently or have no stats
 * row yet -- a closed position's numbers are frozen after its last refresh.
 */
export async function refreshPositionStats(now = new Date()): Promise<number> {
  const recent = new Date(now.getTime() - 5 * 60_000);
  const positions = await db.position.findMany({
    where: {
      positionTokenAddress: { not: null },
      // Closed-but-unsettled every tick, so the settlement lands in the stats
      // however long the withdrawal took.
      OR: [
        { status: { in: ["open", "closed"] } },
        { closedAt: { gte: recent } },
        { settlement: { updatedAt: { gte: recent } } },
        { stats: null },
      ],
    },
  });

  let refreshed = 0;
  for (const position of positions) {
    try {
      await refreshStatsFor(position, now);
      refreshed += 1;
    } catch (error) {
      log.error("stats refresh failed for position", { positionId: position.id, ...errorFields(error) });
    }
  }
  return refreshed;
}
