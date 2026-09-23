import { db } from "../config/db";
import { fromBaseUnits } from "../lib/decimal";
import { notFound } from "../lib/errors";
import { bytes32ToSymbol } from "./markets";

/**
 * Position NAV history -- the stepped line on the position page and the
 * discovery-card sparkline.
 *
 * Every point is the contract's own totalAssets()/totalSupply() as the indexer
 * read them at that report's block (see indexer `handleFunding`), so nothing
 * here re-implements PositionToken's value formula. Shares and USDG share
 * decimals (ERC-7540 over the asset, no offset), so the ratio is directly
 * USDG per token.
 */

/// Decimal places navPerToken is rendered to. Strings, so JSON never rounds.
const NAV_DECIMALS = 6;

export interface NavPoint {
  /// Unix seconds -- what Lightweight Charts takes directly.
  time: number;
  navPerToken: string;
}

export interface NavHistory {
  entry: NavPoint;
  points: NavPoint[];
  closed: boolean;
}

/// Fixed width ("1.000000", not "1") -- floored, never rounded up.
export function navPerToken(totalAssets: bigint, totalSupply: bigint): string {
  const scaled = (totalAssets * 10n ** BigInt(NAV_DECIMALS)) / totalSupply;
  const digits = scaled.toString().padStart(NAV_DECIMALS + 1, "0");
  return `${digits.slice(0, -NAV_DECIMALS)}.${digits.slice(-NAV_DECIMALS)}`;
}

/// ~`limit` evenly spaced points, always keeping the first and the last --
/// the last is the current (or final) NAV and must never be dropped.
export function downsample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  if (limit < 2) return items.slice(-1);
  const picked: T[] = [];
  let previous = -1;
  for (let i = 0; i < limit; i += 1) {
    const index = Math.round((i * (items.length - 1)) / (limit - 1));
    if (index !== previous) picked.push(items[index]);
    previous = index;
  }
  return picked;
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

async function findByToken(positionTokenAddress: string) {
  const position = await db.position.findUnique({
    where: { positionTokenAddress: positionTokenAddress.toLowerCase() },
  });
  if (!position) throw notFound("No position with that token address");
  return position;
}

export async function getNavHistory(positionTokenAddress: string, limit?: number): Promise<NavHistory> {
  const position = await findByToken(positionTokenAddress);

  const reports = await db.positionReport.findMany({
    where: { positionId: position.id },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, totalAssets: true, totalSupply: true, isFinal: true },
  });

  const all = reports
    // Fully redeemed supply has no per-token price; skip rather than divide by zero.
    .filter((report) => BigInt(report.totalSupply) > 0n)
    .map((report) => ({
      time: seconds(report.timestamp),
      navPerToken: navPerToken(BigInt(report.totalAssets), BigInt(report.totalSupply)),
    }));

  return {
    // initialize() mints `initialDeposit` shares for `initialDeposit` assets --
    // initial deposit / initial supply is 1 by construction, at mint time.
    entry: {
      time: seconds(position.openedAt ?? position.createdAt),
      navPerToken: navPerToken(1n, 1n),
    },
    points: limit ? downsample(all, limit) : all,
    closed: position.status === "closed" || reports.some((report) => report.isFinal),
  };
}

/// Public identity of a minted position -- what the position page needs to
/// point its charts at the right market and draw the entry marker.
export async function getPublicPosition(positionTokenAddress: string) {
  const position = await findByToken(positionTokenAddress);
  const market = await db.market.findUnique({ where: { laxuMarket: position.market } });

  let symbol: string | null = null;
  try {
    symbol = bytes32ToSymbol(position.market);
  } catch {
    symbol = null;
  }

  return {
    positionTokenAddress: position.positionTokenAddress,
    status: position.status,
    symbol,
    /// Arcus market name the candles endpoint takes, e.g. "ETH-USD".
    arcusMarket: market?.arcusDisplayName ?? null,
    direction: position.direction,
    leverage: position.leverage,
    nickname: position.nickname,
    /// The creator decides when others can buy in; unlisted, only they can.
    listed: position.listed,
    creator: position.userWalletAddress,
    /// Null while createPool is still being retried -- Borrow stays disabled.
    lendingPoolAddress: position.lendingPoolAddress,
    /// Human price; stored 1e18 fixed point like PositionToken.PRICE_SCALE.
    entryPrice: position.entryPrice ? fromBaseUnits(BigInt(position.entryPrice), 18) : null,
    openedAt: position.openedAt ? seconds(position.openedAt) : null,
    closedAt: position.closedAt ? seconds(position.closedAt) : null,
  };
}
