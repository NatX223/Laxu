import type { Market } from "@prisma/client";

import { notFound } from "../lib/errors";
import { getContext, getFundingSeries } from "../venue/perpl/rest";
import type { ApiFundingEvent } from "../venue/perpl/types";
import { chunkRange, dedupeByFeb, toFundingPoint, whoPays, type FundingPoint } from "./fundingMath";
import { findMarketByName } from "./markets";

/**
 * Funding rates from Perpl's public funding series. The current rate is the
 * newest event: the ticker (`MarketState`) has no funding field. Units and
 * sign in fundingMath.ts.
 */

const INTERVAL_TTL_MS = 10 * 60_000;
const SUMMARY_TTL_MS = 60_000;

let intervals: { at: number; byMarket: Map<number, number> } | undefined;

/// `funding_interval_sec` per Perpl market id, from GET /v1/pub/context.
async function fundingIntervalSec(venueMarketId: number): Promise<number> {
  if (!intervals || Date.now() - intervals.at > INTERVAL_TTL_MS) {
    const context = await getContext();
    intervals = {
      at: Date.now(),
      byMarket: new Map(context.markets.map((m) => [m.id, m.funding_interval_sec ?? 0])),
    };
  }
  const sec = intervals.byMarket.get(venueMarketId);
  if (!sec) throw new Error(`Perpl gives no funding interval for market ${venueMarketId}`);
  return sec;
}

async function resolve(market: string): Promise<Market> {
  const row = await findMarketByName(market);
  if (!row) throw notFound(`Unknown market ${market}`, "UNKNOWN_MARKET");
  return row;
}

/**
 * Funding events of one market applied in [fromMs, toMs], oldest first, one per
 * interval. `market` is a Laxu symbol ("ETH") or display name ("ETH-USD").
 * Long ranges are split into requests of at most 1000 intervals. For a later
 * strategy bot as well as the route below.
 */
export async function getFundingHistory(market: string, fromMs: number, toMs: number): Promise<FundingPoint[]> {
  const row = await resolve(market);
  const intervalSec = await fundingIntervalSec(row.venueMarketId);
  const now = Date.now();
  // Perpl refuses a `to` more than one interval past now (400).
  const to = Math.min(toMs, now + Math.floor(intervalSec * 900));
  const events: ApiFundingEvent[] = [];
  for (const [from, end] of chunkRange(fromMs, to, intervalSec)) {
    const series = await getFundingSeries(row.venueMarketId, from, end);
    events.push(...(series.d ?? []));
  }
  return dedupeByFeb(events).map((e) => toFundingPoint(e, intervalSec, row.priceDecimals, now));
}

export interface FundingSummary {
  market: string;
  venueMarketId: number;
  intervalSec: number;
  /// The newest event; null when the market has no funding history.
  current: (FundingPoint & { whoPays: ReturnType<typeof whoPays> }) | null;
  /// Oldest first.
  history: FundingPoint[];
  convention: "positive rate: longs pay shorts; negative: shorts pay longs";
  fetchedAt: string;
}

const summaries = new Map<string, { at: number; value: Promise<FundingSummary> }>();

/// The route's answer: the last `hours` of funding plus the current rate, cached 60 s.
export function fundingSummary(market: string, hours: number): Promise<FundingSummary> {
  const key = `${market.toUpperCase()}:${hours}`;
  const hit = summaries.get(key);
  if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) return hit.value;

  const value = (async (): Promise<FundingSummary> => {
    const row = await resolve(market);
    const intervalSec = await fundingIntervalSec(row.venueMarketId);
    const now = Date.now();
    const history = await getFundingHistory(row.baseAsset, now - hours * 3_600_000, now + intervalSec * 1000);
    const newest = history[history.length - 1];
    return {
      market: row.displaySymbol,
      venueMarketId: row.venueMarketId,
      intervalSec,
      current: newest ? { ...newest, whoPays: whoPays(newest.rateMicros) } : null,
      history,
      convention: "positive rate: longs pay shorts; negative: shorts pay longs",
      fetchedAt: new Date(now).toISOString(),
    };
  })();
  summaries.set(key, { at: Date.now(), value });
  // A failure is not cached: the next caller tries again.
  value.catch(() => summaries.delete(key));
  if (summaries.size > 200) summaries.delete(summaries.keys().next().value as string);
  return value;
}
