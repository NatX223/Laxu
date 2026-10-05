import type { Market } from "@prisma/client";
import { hexToString, stringToHex } from "viem";

import { db } from "../config/db";
import { badRequest, serviceUnavailable } from "../lib/errors";
import { fromPrice18 } from "../lib/units";
import { LAXU_MAX_LEVERAGE as MAX_LEVERAGE } from "../venue/perpl/units";
import { venue } from "../venue/types";

/**
 * Laxu <-> Perpl market mapping. Rows are written by marketSync.ts from
 * `GET /v1/pub/context`; this file reads them.
 *
 * Not a display-name lookup: an order carries the price and size as integers
 * scaled by the market's `priceDecimals` / `sizeDecimals`, the API addresses
 * the market by `venueMarketId` and the chain by `perpetualId`. Without a row
 * here no order can be built at all.
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

/// The stable market id for a base asset. Lowercase hex, which is how
/// positions and open requests store it.
export function marketIdFor(baseAsset: string): string {
  return symbolToBytes32(baseAsset.toUpperCase()).toLowerCase();
}

// ---------------------------------------------------------------------------
// Leverage
// ---------------------------------------------------------------------------

/// LendingPool's risk tiers stop at 20x; anything above would silently fall
/// into the 11-20x tier.
export const LAXU_MAX_LEVERAGE = MAX_LEVERAGE;

type LeverageInputs = Pick<Market, "initialMarginFraction">;

function leverageFor(imf: string): number {
  const fraction = Number(imf);
  // A missing or nonsensical fraction must never widen the limit.
  if (!Number.isFinite(fraction) || fraction <= 0) return 1;
  // +1e-9 guards float error: 1/0.04 is 24.999…
  return Math.max(1, Math.min(LAXU_MAX_LEVERAGE, Math.floor(1 / fraction + 1e-9)));
}

/// `min(20, floor(1 / initialMarginFraction))`. Perpl trades 24/7, so there is
/// no off-hours limit.
export function maxLeverage(m: LeverageInputs): number {
  return leverageFor(m.initialMarginFraction);
}

/// Kept for callers written against a venue with trading hours: all three are
/// the same limit on Perpl.
export function leverageLimits(m: LeverageInputs): { now: number; inHours: number; offHours: number } {
  const limit = maxLeverage(m);
  return { now: limit, inHours: limit, offHours: limit };
}

// ---------------------------------------------------------------------------
// Lookups -- throw rather than return null: every caller is about to build an
// order or quote a market, and a missing one is not something to paper over.
// ---------------------------------------------------------------------------

export interface ResolvedMarket {
  /// bytes32 id, lowercase hex.
  laxuMarket: string;
  /// Base asset, e.g. "ETH".
  symbol: string;
  /// "ETH-USD".
  displaySymbol: string;
  /// Perpl API market id (`mkt`).
  venueMarketId: number;
  /// Perpl on-chain perpetual id.
  perpetualId: number;
  priceDecimals: number;
  sizeDecimals: number;
  orderTtlBlocks: number;
  maxSlippageBps: number;
  takerFeeMicros: number;
  /// Raw API Amount string.
  minPostingAmount: string;
  initialMarginFraction: string;
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

/// The market a position trades on, whatever its status: closing, settling
/// and liquidation checks must still work after a market goes OFFLINE.
export async function marketForPosition(laxuMarket: string): Promise<ResolvedMarket> {
  const row = await db.market.findUnique({ where: { id: laxuMarket.toLowerCase() } });
  if (!row) throw new Error(`Unknown market ${laxuMarket} (${safeSymbol(laxuMarket)})`);
  return toResolved(row);
}

/// Accepts the base asset ("ETH") or the display name ("ETH-USD"), any case.
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
    throw serviceUnavailable(`${row.displaySymbol} is ${row.status} on Perpl`, "MARKET_OFFLINE");
  }
  return toResolved(row);
}

export function toResolved(row: Market): ResolvedMarket {
  return {
    laxuMarket: row.id,
    symbol: row.baseAsset,
    displaySymbol: row.displaySymbol,
    venueMarketId: row.venueMarketId,
    perpetualId: row.perpetualId,
    priceDecimals: row.priceDecimals,
    sizeDecimals: row.sizeDecimals,
    orderTtlBlocks: row.orderTtlBlocks,
    maxSlippageBps: row.maxSlippageBps,
    takerFeeMicros: row.takerFeeMicros,
    minPostingAmount: row.minPostingAmount,
    initialMarginFraction: row.initialMarginFraction,
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

/// The frontend reads none of the trading-hours fields, so they are not sent.
export function serialiseMarket(market: Market) {
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
    maxLeverage: maxLeverage(market),
    stepSize: market.stepSize,
    minOrderSize: market.minOrderSize,
    minOrderNotional: market.minOrderNotional,
    /// Perpl's API market id -- what the public market-data endpoints take.
    venueMarketId: market.venueMarketId,
    syncedAt: market.syncedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Fresh reads -- for anything that decides whether money moves, never the (up
// to a minute old) row.
// ---------------------------------------------------------------------------

/// Current mark, human decimal string, from Perpl's ticker. Sizing and
/// display only: the contracts read the venue's mark on-chain themselves.
export async function markPriceFor(market: ResolvedMarket): Promise<string> {
  try {
    return fromPrice18(await venue().markPrice(market));
  } catch (error) {
    throw serviceUnavailable(
      `No mark price for ${market.displaySymbol}: ${error instanceof Error ? error.message : String(error)}`,
      "NO_MARK_PRICE",
    );
  }
}
