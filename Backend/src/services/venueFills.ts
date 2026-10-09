import { db } from "../config/db";
import { HttpError, notFound } from "../lib/errors";
import { createLogger, errorFields } from "../lib/logger";
import { getFills, getPositionHistory, PerplApiError, walkHistory } from "../venue/perpl/rest";
import { collateralScale } from "../venue/perpl/units";
import { credentialsFor, getSlot } from "./allocator";
import {
  matchFills,
  positionOrders,
  reachedBefore,
  realisedFunding,
  toVenueFill,
  type MatchKeys,
  type MatchMethod,
  type VenueFill,
} from "./venueFillsMath";

const log = createLogger("venue-fills");

/**
 * "Fills on Perpl" for one position: its real fills, straight from Perpl's
 * signed history endpoints, as proof the position traded there. Display only:
 * order history lags the socket by ~25 s, so nothing here drives the system.
 * Matching is in venueFillsMath.ts.
 */

export interface VenueFillsResponse {
  source: "perpl";
  positionTokenAddress: string | null;
  /// Perpl account id of the slot that held the position.
  accountId: string | null;
  market: string | null;
  matchedBy: MatchMethod | null;
  fills: VenueFill[];
  /// Funding realised on Perpl so far (AUSD, positive = received), from the
  /// position-history events. Null when the position could not be identified.
  realisedFunding: string | null;
  fetchedAt: string;
  /// The page cap was hit before the walk reached the position's open time.
  truncated: boolean;
  /// Served from cache because Perpl answered 429 (or failed).
  stale?: boolean;
}

const CACHE_MS = 15_000;
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
/// Padding around [open request, close]: the entry fill lands before the
/// token mints (openedAt), and the close fill before closedAt is written.
const BEFORE_MS = 5 * 60_000;
const AFTER_MS = 10 * 60_000;
/// Upstream history walks at once, across all positions.
const MAX_CONCURRENT = 2;

let running = 0;
const waiting: Array<() => void> = [];

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/**
 * The 15 s cache around a loader, one upstream load per key at a time. When
 * Perpl refuses (429) or fails, the last answer is served with `stale: true`;
 * with nothing cached, a clear 503/502 error object instead of a stack.
 */
export function cachedLoader(
  loader: (key: string) => Promise<VenueFillsResponse>,
  ttlMs = CACHE_MS,
): (key: string) => Promise<VenueFillsResponse> {
  const cache = new Map<string, { at: number; value: VenueFillsResponse }>();
  const inflight = new Map<string, Promise<VenueFillsResponse>>();

  return async (key) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;

    let pending = inflight.get(key);
    if (!pending) {
      pending = loader(key).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    try {
      const value = await pending;
      cache.set(key, { at: Date.now(), value });
      if (cache.size > 500) cache.delete(cache.keys().next().value as string);
      return value;
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) throw error;
      const rateLimited = error instanceof PerplApiError && error.status === 429;
      if (hit) return { ...hit.value, stale: true };
      log.warn("venue fills unavailable", { key, rateLimited, ...errorFields(error) });
      throw rateLimited
        ? new HttpError(503, "Perpl is rate limiting history requests; try again in a few seconds", "VENUE_RATE_LIMITED")
        : new HttpError(502, "Couldn't read fills from Perpl right now", "VENUE_UNAVAILABLE");
    }
  };
}

const cachedFills = cachedLoader((key) => load(key));

/// `key` is the position's token address or its database id.
export function venueFillsFor(key: string): Promise<VenueFillsResponse> {
  return cachedFills(key.toLowerCase().startsWith("0x") ? key.toLowerCase() : key);
}

async function load(key: string): Promise<VenueFillsResponse> {
  const position = await db.position.findFirst({
    where: key.startsWith("0x") ? { positionTokenAddress: key } : { id: key },
    include: { ledgerEntries: { select: { venueOrderId: true } } },
  });
  if (!position) throw notFound("Position not found", "POSITION_NOT_FOUND");

  const empty: VenueFillsResponse = {
    source: "perpl",
    positionTokenAddress: position.positionTokenAddress,
    accountId: null,
    market: null,
    matchedBy: null,
    fills: [],
    realisedFunding: null,
    fetchedAt: new Date().toISOString(),
    truncated: false,
  };

  // The open request keeps the slot after the slot itself is freed and reused.
  const request = position.positionTokenAddress
    ? await db.positionOpenRequest.findFirst({
        where: { positionTokenAddress: position.positionTokenAddress },
        select: { slotId: true, createdAt: true },
      })
    : null;
  const slotId =
    request?.slotId ??
    (await db.subaccountSlot.findFirst({ where: { positionId: position.id }, select: { id: true } }))?.id;
  const market = await db.market.findUnique({ where: { id: position.market } });
  if (!slotId || !market) return empty;
  const slot = await getSlot(slotId);
  if (!slot.perplAccountId) return empty;

  const keys: MatchKeys = {
    accountId: slot.perplAccountId,
    marketId: market.venueMarketId,
    pid: position.venuePositionPid,
    knownOrderIds: [position.venueOrderId, ...position.ledgerEntries.map((e) => e.venueOrderId)].filter(
      (id): id is string => Boolean(id),
    ),
    fromMs: (request?.createdAt ?? position.createdAt).getTime() - BEFORE_MS,
    toMs: (position.closedAt?.getTime() ?? Date.now()) + AFTER_MS,
  };

  const credentials = credentialsFor(slot);
  const walk = <T extends { at?: { t?: number } }>(fetchPage: (page?: string) => Promise<{ d: T[]; np?: string }>) =>
    limited(async () => {
      let pages = 0;
      let reached = false;
      let more = false;
      const items = await walkHistory(
        async (page) => {
          pages += 1;
          const result = await fetchPage(page);
          more = Boolean(result.np) && result.d.length > 0;
          return result;
        },
        (page) => (reached = reachedBefore(page, keys.fromMs)),
        MAX_PAGES,
      );
      // Out of pages with more to read: the oldest fills may be missing.
      return { items, truncated: pages >= MAX_PAGES && more && !reached };
    });

  const [fills, history, scale] = await Promise.all([
    walk((page) => getFills(credentials, page, PAGE_SIZE)),
    walk((page) => getPositionHistory(credentials, page, PAGE_SIZE)),
    collateralScale(),
  ]);

  const orders = positionOrders(history.items, keys);
  const matched = matchFills(fills.items, keys, orders.orderIds);
  const scales = { priceDecimals: market.priceDecimals, sizeDecimals: market.sizeDecimals, cnsDecimals: scale.cnsDecimals };

  return {
    ...empty,
    accountId: slot.perplAccountId,
    market: market.displaySymbol,
    matchedBy: matched.matchedBy,
    fills: matched.fills.map((fill) => toVenueFill(fill, scales)),
    realisedFunding: orders.events.length > 0 ? realisedFunding(orders.events, scale.cnsDecimals) : null,
    truncated: fills.truncated || history.truncated,
  };
}
