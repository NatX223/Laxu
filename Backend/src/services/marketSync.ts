import { Prisma } from "@prisma/client";

import { getMarketMeta, getMarkets } from "../arcus/client";
import type { ArcusMarketInfo } from "../arcus/types";
import { db } from "../config/db";
import { config } from "../config/env";
import { startWorker } from "../lib/async";
import { createLogger, errorFields } from "../lib/logger";
import { markOf, marketIdFor } from "./markets";

const log = createLogger("market-sync");

/**
 * Keeps the markets table in step with Arcus `GET /v1/markets` -- one call for
 * every market. Runs at boot and every minute, which keeps `status`,
 * `isOutsideRth` and the display prices fresh.
 *
 * Rows are never deleted: positions reference them, so a market that vanishes
 * from Arcus goes OFFLINE instead.
 */

export type MarketData = Omit<Prisma.MarketUncheckedCreateInput, "id" | "syncedAt">;

/// The only storage the sync needs -- narrow so tests can run it in memory.
export interface MarketStore {
  existing(): Promise<Array<{ id: string; arcusMarketId: number; logoUrl: string | null }>>;
  save(id: string, data: MarketData): Promise<void>;
  /// Moves `arcusMarketId` off any row other than `keepId`. Arcus testnet
  /// resets can hand an id to a different asset; the stale row keeps the
  /// negated id (still unique) until it is seen again.
  releaseArcusId(arcusMarketId: number, keepId: string): Promise<void>;
  markOfflineExcept(ids: string[]): Promise<number>;
}

export interface SyncDeps {
  fetchMarkets: () => Promise<ArcusMarketInfo[]>;
  /// Called only for markets with no logo stored yet.
  resolveLogo: (baseAsset: string) => Promise<string | null>;
  store: MarketStore;
}

export const prismaMarketStore: MarketStore = {
  existing: () => db.market.findMany({ select: { id: true, arcusMarketId: true, logoUrl: true } }),
  async save(id, data) {
    await db.market.upsert({ where: { id }, update: data, create: { id, ...data } });
  },
  async releaseArcusId(arcusMarketId, keepId) {
    await db.market.updateMany({
      where: { arcusMarketId, id: { not: keepId } },
      data: { arcusMarketId: -arcusMarketId, status: "OFFLINE" },
    });
  },
  async markOfflineExcept(ids) {
    const result = await db.market.updateMany({
      where: { id: { notIn: ids }, status: { not: "OFFLINE" } },
      data: { status: "OFFLINE" },
    });
    return result.count;
  },
};

export function toMarketData(m: ArcusMarketInfo): MarketData {
  const initialMarginFraction = m.initialMarginFraction ?? "1";
  return {
    arcusMarketId: m.marketId,
    displaySymbol: m.marketDisplayName.toUpperCase(),
    baseAsset: m.baseAsset.toUpperCase(),
    fullAssetName: m.fullAssetName ?? m.baseAsset,
    assetClass: m.category ?? "OTHER",
    status: m.status,
    initialMarginFraction,
    offHoursInitialMarginFraction: m.offHoursInitialMarginFraction ?? initialMarginFraction,
    isOutsideRth: m.isOutsideRth ?? false,
    // Prisma needs DbNull, not null, to write SQL NULL into a Json column.
    regularTradingHours: m.regularTradingHours
      ? (m.regularTradingHours as unknown as Prisma.InputJsonValue)
      : Prisma.DbNull,
    tickSize: m.tickSize,
    stepSize: m.stepSize,
    minOrderSize: m.minOrderSize,
    maxOrderSize: m.maxOrderSize,
    minOrderNotional: m.minOrderNotional ?? "0",
    maintenanceMarginFraction: m.maintenanceMarginFraction ?? "0",
    markPrice: markOf(m) ?? "0",
    priceChange24h: m.priceChange24h ?? "0",
  };
}

export async function syncMarkets(deps: SyncDeps = defaultDeps()): Promise<{ synced: number; offline: number }> {
  const markets = await deps.fetchMarkets();
  // An empty answer is far more likely an Arcus hiccup than every market
  // delisting at once -- don't take the whole table OFFLINE over it.
  if (markets.length === 0) throw new Error("Arcus returned no markets");

  const existing = new Map((await deps.store.existing()).map((row) => [row.id, row]));
  const liveIds: string[] = [];

  for (const m of markets) {
    const id = marketIdFor(m.baseAsset);
    // The id is the base asset, so two markets on one asset would fight over a
    // row. Arcus has none today; keep the first rather than flap between them.
    if (liveIds.includes(id)) {
      log.warn("second market for the same base asset skipped", { baseAsset: m.baseAsset, market: m.marketDisplayName });
      continue;
    }
    liveIds.push(id);

    try {
      const data = toMarketData(m);
      const row = existing.get(id);
      // Logos: only for new markets or ones still missing one -- not every minute.
      if (!row?.logoUrl) data.logoUrl = await deps.resolveLogo(data.baseAsset);
      if (row?.arcusMarketId !== m.marketId) await deps.store.releaseArcusId(m.marketId, id);
      await deps.store.save(id, data);
    } catch (error) {
      log.error("market sync failed for one market", { market: m.marketDisplayName, ...errorFields(error) });
    }
  }

  const offline = await deps.store.markOfflineExcept(liveIds);
  if (offline > 0) log.warn("markets no longer listed on Arcus marked OFFLINE", { count: offline });
  return { synced: liveIds.length, offline };
}

// ---------------------------------------------------------------------------
// Logos
// ---------------------------------------------------------------------------

export interface LogoDeps {
  /// The metadata endpoint's logo for a ticker, or null.
  metaLogo: (ticker: string) => Promise<string | null>;
  /// True when a HEAD request for the URL succeeds.
  exists: (url: string) => Promise<boolean>;
  brandingBaseUrl: string;
}

/**
 * 1. The metadata endpoint's `logo` field -- the official source.
 * 2. The predictable branding path, checked with a HEAD request.
 * 3. Null -- the frontend draws a letter avatar.
 */
export async function resolveLogo(baseAsset: string, deps: LogoDeps): Promise<string | null> {
  try {
    const logo = await deps.metaLogo(baseAsset);
    if (logo) return logo;
  } catch {
    // No metadata record for this market; fall through.
  }

  const url = `${deps.brandingBaseUrl.replace(/\/$/, "")}/markets/branding/${baseAsset}.png`;
  const ok = await deps.exists(url).catch(() => false);
  return ok ? url : null;
}

/**
 * Production logo deps for one sync pass. The metadata endpoint is keyed by
 * ticker ("TSM", not "TSM-USD"), and its full list covers most markets, so it
 * is fetched once per pass and only then per ticker for the rest.
 */
function liveLogoDeps(): LogoDeps {
  let list: Promise<Map<string, string>> | null = null;
  const all = () =>
    (list ??= getMarketMeta()
      .then((records) => new Map(records.filter((r) => r.logo).map((r) => [r.ticker.toUpperCase(), r.logo as string])))
      .catch(() => new Map<string, string>()));

  return {
    async metaLogo(ticker) {
      const fromList = (await all()).get(ticker.toUpperCase());
      if (fromList) return fromList;
      const [record] = await getMarketMeta(ticker);
      return record?.logo ?? null;
    },
    async exists(url) {
      const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(config.arcusRequestTimeoutMs) });
      return res.ok;
    },
    brandingBaseUrl: config.arcusBrandingBaseUrl,
  };
}

function defaultDeps(): SyncDeps {
  const logoDeps = liveLogoDeps();
  return {
    fetchMarkets: () => getMarkets(),
    resolveLogo: (baseAsset) => resolveLogo(baseAsset, logoDeps),
    store: prismaMarketStore,
  };
}

export function startMarketSync(): () => void {
  log.info("market sync starting", { intervalMs: config.marketSyncIntervalMs });
  return startWorker(
    "market-sync",
    config.marketSyncIntervalMs,
    async () => {
      await syncMarkets();
    },
    (error) => log.error("market sync tick threw", errorFields(error)),
  );
}
