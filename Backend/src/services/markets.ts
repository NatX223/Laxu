import type { Market } from "@prisma/client";
import { hexToString, stringToHex } from "viem";

import { getMarkets } from "../arcus/client";
import { db } from "../config/db";
import { badRequest, serviceUnavailable } from "../lib/errors";
import { createLogger } from "../lib/logger";

const log = createLogger("markets");

/**
 * Laxu <-> Arcus market mapping.
 *
 * This is not a display-name lookup. Order signing converts the human price and
 * size into the integer ticks and quantums that the Ed25519 payload is built
 * from, and those divisions must be exact against the market's `tickSize` and
 * `stepSize`. Without a resolved row here an order cannot be signed at all.
 *
 * The bytes32 key is the Laxu symbol, right-padded -- exactly what
 * PositionToken stores and what its `_bytes32ToString` renders back into the
 * token's name and symbol.
 */

export function symbolToBytes32(symbol: string): string {
  return stringToHex(symbol, { size: 32 });
}

export function bytes32ToSymbol(value: string): string {
  return hexToString(value as `0x${string}`, { size: 32 }).replace(/\0+$/, "");
}

export interface ResolvedMarket {
  laxuMarket: string;
  symbol: string;
  arcusMarketId: number;
  arcusDisplayName: string;
  tickSize: string;
  stepSize: string;
  minOrderSize: string;
  maxOrderSize: string;
  maxLeverage: number | null;
}

/// Throws rather than returning null: every caller here is about to sign an
/// order, and a half-resolved market is not something to paper over.
export async function requireMarket(laxuMarket: string): Promise<ResolvedMarket> {
  const row = await db.market.findUnique({ where: { laxuMarket: laxuMarket.toLowerCase() } });
  if (!row) {
    throw badRequest(
      `Unknown market ${laxuMarket} (${safeSymbol(laxuMarket)}). Add it to the markets table and run the market refresh.`,
      "UNKNOWN_MARKET",
    );
  }
  return assertResolved(row);
}

export async function requireMarketBySymbol(symbol: string): Promise<ResolvedMarket> {
  const row = await db.market.findUnique({ where: { symbol: symbol.toUpperCase() } });
  if (!row) {
    throw badRequest(`Unknown market symbol ${symbol}`, "UNKNOWN_MARKET");
  }
  return assertResolved(row);
}

/// Accepts the Laxu symbol ("ETH") or the Arcus display name ("ETH-USD").
export async function requireMarketByName(name: string): Promise<ResolvedMarket> {
  const upper = name.toUpperCase();
  const row =
    (await db.market.findUnique({ where: { symbol: upper } })) ??
    (await db.market.findFirst({ where: { arcusDisplayName: upper } }));
  if (!row) {
    throw badRequest(`Unknown market ${name}`, "UNKNOWN_MARKET");
  }
  return assertResolved(row);
}

function safeSymbol(laxuMarket: string): string {
  try {
    return bytes32ToSymbol(laxuMarket);
  } catch {
    return "undecodable";
  }
}

function assertResolved(row: Market): ResolvedMarket {
  const missing: string[] = [];
  if (row.arcusMarketId === null) missing.push("arcusMarketId");
  if (!row.tickSize) missing.push("tickSize");
  if (!row.stepSize) missing.push("stepSize");

  if (missing.length > 0) {
    throw serviceUnavailable(
      `Market ${row.symbol} is not resolved against Arcus yet (missing ${missing.join(", ")}). Run refreshMarkets().`,
      "MARKET_UNRESOLVED",
    );
  }

  if (row.status === "OFFLINE") {
    throw serviceUnavailable(`Market ${row.symbol} is OFFLINE on Arcus`, "MARKET_OFFLINE");
  }

  return {
    laxuMarket: row.laxuMarket,
    symbol: row.symbol,
    arcusMarketId: row.arcusMarketId as number,
    arcusDisplayName: row.arcusDisplayName ?? row.symbol,
    tickSize: row.tickSize as string,
    stepSize: row.stepSize as string,
    minOrderSize: row.minOrderSize ?? "0",
    maxOrderSize: row.maxOrderSize ?? "0",
    maxLeverage: row.maxLeverage,
  };
}

/**
 * Pull `GET /v1/markets` and fill in the Arcus side of every row.
 *
 * Matching is by `arcusDisplayName` when the row already names one, otherwise by
 * `<SYMBOL>-USD`, which is how Arcus names its USD-quoted perps. Rows that find
 * no counterpart are left `UNRESOLVED` and reported rather than dropped -- a
 * silently missing market would surface as a signing failure much later.
 */
export async function refreshMarkets(): Promise<{
  resolved: number;
  unresolved: string[];
}> {
  const rows = await db.market.findMany();
  if (rows.length === 0) {
    log.warn("markets table is empty; nothing to refresh (run the seed first)");
    return { resolved: 0, unresolved: [] };
  }

  const remote = await getMarkets();
  const byName = new Map(remote.map((m) => [m.marketDisplayName.toUpperCase(), m]));
  const byId = new Map(remote.map((m) => [m.marketId, m]));

  const unresolved: string[] = [];
  let resolved = 0;

  for (const row of rows) {
    const match =
      (row.arcusMarketId !== null ? byId.get(row.arcusMarketId) : undefined) ??
      (row.arcusDisplayName ? byName.get(row.arcusDisplayName.toUpperCase()) : undefined) ??
      byName.get(`${row.symbol.toUpperCase()}-USD`);

    if (!match) {
      unresolved.push(row.symbol);
      await db.market.update({
        where: { laxuMarket: row.laxuMarket },
        data: { status: "UNRESOLVED", refreshedAt: new Date() },
      });
      continue;
    }

    await db.market.update({
      where: { laxuMarket: row.laxuMarket },
      data: {
        arcusMarketId: match.marketId,
        arcusDisplayName: match.marketDisplayName,
        tickSize: match.tickSize,
        stepSize: match.stepSize,
        minOrderSize: match.minOrderSize,
        maxOrderSize: match.maxOrderSize,
        status: match.status ?? "ONLINE",
        maxLeverage:
          match.maxLeverage !== undefined ? Math.floor(Number(match.maxLeverage)) : row.maxLeverage,
        refreshedAt: new Date(),
      },
    });
    resolved += 1;
  }

  log.info("markets refreshed", { resolved, unresolved });
  if (unresolved.length > 0) {
    log.warn("markets with no Arcus counterpart", { symbols: unresolved });
  }

  return { resolved, unresolved };
}

export async function listMarkets(): Promise<Market[]> {
  return db.market.findMany({ orderBy: { symbol: "asc" } });
}

/// Current mark, used for the protective slippage bound on a MARKET order.
export async function markPriceFor(market: ResolvedMarket): Promise<string> {
  const [info] = await getMarkets(String(market.arcusMarketId));
  const price = info?.markPrice && info.markPrice !== "0" ? info.markPrice : info?.oraclePrice;
  if (!price || price === "0") {
    throw serviceUnavailable(
      `Arcus has no mark price for ${market.arcusDisplayName} yet`,
      "NO_MARK_PRICE",
    );
  }
  return price;
}
