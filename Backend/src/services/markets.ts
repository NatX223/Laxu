import type { Market } from "@prisma/client";
import { hexToString, stringToHex } from "viem";

import { getMarkets } from "../arcus/client";
import type { ArcusMarketInfo, ArcusTradingHours } from "../arcus/types";
import { db } from "../config/db";
import { badRequest, serviceUnavailable } from "../lib/errors";

/**
 * Laxu <-> Arcus market mapping. Rows are written by marketSync.ts from
 * `GET /v1/markets`; this file reads them.
 *
 * This is not a display-name lookup. Order signing converts the human price and
 * size into the integer ticks and quantums that the Ed25519 payload is built
 * from, and those divisions must be exact against the market's `tickSize` and
 * `stepSize`. Without a row here an order cannot be signed at all.
 *
 * The id is the base asset as bytes32, right-padded -- exactly what
 * PositionToken stores and what its `_bytes32ToString` renders back into the
 * token's name and symbol.
 */

export function symbolToBytes32(symbol: string): string {
  return stringToHex(symbol, { size: 32 });
}

export function bytes32ToSymbol(value: string): string {
  return hexToString(value as `0x${string}`, { size: 32 }).replace(/\0+$/, "");
}

/// The stable market id for an Arcus base asset. Lowercase hex, which is how
/// positions and open requests store it.
export function marketIdFor(baseAsset: string): string {
  return symbolToBytes32(baseAsset.toUpperCase()).toLowerCase();
}

// ---------------------------------------------------------------------------
// Leverage
// ---------------------------------------------------------------------------

/// LendingPool's risk tiers stop at 20x; anything above would silently fall
/// into the 11-20x tier.
export const LAXU_MAX_LEVERAGE = 20;

type LeverageInputs = Pick<Market, "initialMarginFraction" | "offHoursInitialMarginFraction" | "isOutsideRth">;

function leverageFor(imf: string): number {
  const fraction = Number(imf);
  // A missing or nonsensical fraction must never widen the limit.
  if (!Number.isFinite(fraction) || fraction <= 0) return 1;
  // +1e-9 guards float error: 1/0.04 is 24.999…
  return Math.max(1, Math.min(LAXU_MAX_LEVERAGE, Math.floor(1 / fraction + 1e-9)));
}

/// Arcus's limit is 1 / initialMarginFraction, using the off-hours fraction
/// while the market is outside its trading-hours window. Laxu caps it at 20x.
export function maxLeverage(m: LeverageInputs): number {
  return leverageFor(m.isOutsideRth ? m.offHoursInitialMarginFraction : m.initialMarginFraction);
}

export function leverageLimits(m: LeverageInputs): { now: number; inHours: number; offHours: number } {
  return {
    now: maxLeverage(m),
    inHours: leverageFor(m.initialMarginFraction),
    offHours: leverageFor(m.offHoursInitialMarginFraction),
  };
}

/// The same inputs read straight off an Arcus response rather than a row.
export function leverageInputsFrom(info: ArcusMarketInfo): LeverageInputs {
  const initialMarginFraction = info.initialMarginFraction ?? "1";
  return {
    initialMarginFraction,
    offHoursInitialMarginFraction: info.offHoursInitialMarginFraction ?? initialMarginFraction,
    isOutsideRth: info.isOutsideRth ?? false,
  };
}

// ---------------------------------------------------------------------------
// Lookups -- throw rather than return null: every caller is about to sign an
// order or quote a market, and a missing one is not something to paper over.
// ---------------------------------------------------------------------------

export interface ResolvedMarket {
  /// bytes32 id, lowercase hex.
  laxuMarket: string;
  /// Base asset, e.g. "ETH".
  symbol: string;
  arcusMarketId: number;
  /// Arcus display name, e.g. "ETH-USD".
  arcusDisplayName: string;
  tickSize: string;
  stepSize: string;
  minOrderSize: string;
  maxOrderSize: string;
  minOrderNotional: string;
}

export async function requireMarket(laxuMarket: string): Promise<ResolvedMarket> {
  const row = await db.market.findUnique({ where: { id: laxuMarket.toLowerCase() } });
  if (!row) {
    throw badRequest(`Unknown market ${laxuMarket} (${safeSymbol(laxuMarket)})`, "UNKNOWN_MARKET");
  }
  return assertOnline(row);
}

/// Accepts the base asset ("ETH") or the Arcus display name ("ETH-USD"), any case.
export async function requireMarketByName(name: string): Promise<ResolvedMarket> {
  const row = await findMarketByName(name);
  if (!row) throw badRequest(`Unknown market ${name}`, "UNKNOWN_MARKET");
  return assertOnline(row);
}

export async function findMarketByName(name: string): Promise<Market | null> {
  const upper = name.trim().toUpperCase();
  return (
    (await db.market.findUnique({ where: { displaySymbol: upper } })) ??
    (await db.market.findUnique({ where: { baseAsset: upper } }))
  );
}

function safeSymbol(laxuMarket: string): string {
  try {
    return bytes32ToSymbol(laxuMarket);
  } catch {
    return "undecodable";
  }
}

function assertOnline(row: Market): ResolvedMarket {
  if (row.status !== "ONLINE") {
    throw serviceUnavailable(`${row.displaySymbol} is ${row.status} on Arcus`, "MARKET_OFFLINE");
  }
  return toResolved(row);
}

function toResolved(row: Market): ResolvedMarket {
  return {
    laxuMarket: row.id,
    symbol: row.baseAsset,
    arcusMarketId: row.arcusMarketId,
    arcusDisplayName: row.displaySymbol,
    tickSize: row.tickSize,
    stepSize: row.stepSize,
    minOrderSize: row.minOrderSize,
    maxOrderSize: row.maxOrderSize,
    minOrderNotional: row.minOrderNotional,
  };
}

// ---------------------------------------------------------------------------
// Public listing
// ---------------------------------------------------------------------------

export async function listMarkets({ all = false } = {}): Promise<Market[]> {
  return db.market.findMany({
    where: all ? undefined : { status: "ONLINE" },
    orderBy: [{ assetClass: "asc" }, { displaySymbol: "asc" }],
  });
}

/// Seconds-of-day -> "HH:MM".
function clock(secondsOfDay: number): string {
  const minutes = Math.floor(secondsOfDay / 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function tradingHoursOf(
  raw: unknown,
): { start: string; end: string; timezone: string } | null {
  const hours = raw as ArcusTradingHours | null | undefined;
  if (!hours || typeof hours.startSecondsOfDay !== "number" || typeof hours.endSecondsOfDay !== "number") {
    return null;
  }
  return { start: clock(hours.startSecondsOfDay), end: clock(hours.endSecondsOfDay), timezone: hours.timezone };
}

export function serialiseMarket(market: Market) {
  const limits = leverageLimits(market);
  return {
    id: market.id,
    displaySymbol: market.displaySymbol,
    baseAsset: market.baseAsset,
    fullAssetName: market.fullAssetName,
    assetClass: market.assetClass,
    status: market.status,
    logoUrl: market.logoUrl,
    markPrice: market.markPrice,
    priceChange24h: market.priceChange24h,
    /// The limit right now; the other two drive the frontend's hours hint.
    maxLeverage: limits.now,
    maxLeverageInHours: limits.inHours,
    maxLeverageOffHours: limits.offHours,
    isOutsideRth: market.isOutsideRth,
    tradingHours: tradingHoursOf(market.regularTradingHours),
    stepSize: market.stepSize,
    minOrderSize: market.minOrderSize,
    minOrderNotional: market.minOrderNotional,
    syncedAt: market.syncedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Fresh Arcus reads -- for anything that decides whether money moves, never
// the (up to a minute old) row.
// ---------------------------------------------------------------------------

export async function liveMarketInfo(market: Pick<ResolvedMarket, "arcusMarketId" | "arcusDisplayName">): Promise<ArcusMarketInfo> {
  const [info] = await getMarkets(String(market.arcusMarketId));
  if (!info || info.marketId !== market.arcusMarketId) {
    throw serviceUnavailable(`Arcus returned no data for ${market.arcusDisplayName}`, "MARKET_UNAVAILABLE");
  }
  return info;
}

/// Mark, falling back to oracle before the first trade. Null when Arcus has neither.
export function markOf(info: ArcusMarketInfo): string | null {
  if (info.markPrice && info.markPrice !== "0") return info.markPrice;
  if (info.oraclePrice && info.oraclePrice !== "0") return info.oraclePrice;
  return null;
}

/// Current mark, used for the protective slippage bound on a MARKET order.
export async function markPriceFor(market: ResolvedMarket): Promise<string> {
  const price = markOf(await liveMarketInfo(market));
  if (!price) {
    throw serviceUnavailable(`Arcus has no mark price for ${market.arcusDisplayName} yet`, "NO_MARK_PRICE");
  }
  return price;
}
