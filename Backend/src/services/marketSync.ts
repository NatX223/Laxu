import type { Prisma } from "@prisma/client";
import type { Address } from "viem";

import { perplReaderAbi } from "../chain/abi";
import { publicClient, readerAddress } from "../chain/clients";
import { db } from "../config/db";
import { config } from "../config/env";
import { startWorker } from "../lib/async";
import { formatDecimal } from "../lib/decimal";
import { alert, createLogger, errorFields } from "../lib/logger";
import { getPerpetualInfo } from "../venue/perpl/exchange";
import { getContext } from "../venue/perpl/rest";
import type { ApiContext, ApiMarket } from "../venue/perpl/types";
import { marginFraction, pnsToDecimal, stepOf } from "../venue/perpl/units";
import { marketIdFor, symbolToBytes32 } from "./markets";

const log = createLogger("market-sync");

/**
 * Keeps the markets table in step with Perpl's `GET /v1/pub/context` -- one
 * public call for every market. Runs at boot and every minute, which keeps
 * `status` and the display prices fresh.
 *
 * A market may only be ONLINE when it is open on Perpl, its API decimals match
 * the Exchange's on-chain ones (checked once per market per process), and
 * PerplReader maps its bytes32 id -- without that mapping no token can be
 * created on it.
 *
 * Rows are never deleted: positions reference them, so a market that vanishes
 * from Perpl goes OFFLINE instead.
 */

export type MarketData = Omit<Prisma.MarketUncheckedCreateInput, "id" | "syncedAt">;

/// The only storage the sync needs -- narrow so tests can run it in memory.
export interface MarketStore {
  existing(): Promise<Array<{ id: string; venueMarketId: number; perpetualId: number; logoUrl: string | null }>>;
  save(id: string, data: MarketData): Promise<void>;
  /// Moves `venueMarketId` / `perpetualId` off any row other than `keepId`. A
  /// testnet reset can hand an id to a different asset; the stale row keeps
  /// the negated ids (still unique) until it is seen again.
  releaseVenueIds(venueMarketId: number, perpetualId: number, keepId: string): Promise<void>;
  markOfflineExcept(ids: string[]): Promise<number>;
}

export interface OnChainCheck {
  ok: boolean;
  reason?: string;
}

export interface SyncDeps {
  fetchContext: () => Promise<ApiContext>;
  /// Decimals match on-chain and PerplReader maps the market.
  checkOnChain: (market: ApiMarket, laxuMarket: string) => Promise<OnChainCheck>;
  store: MarketStore;
}

export const prismaMarketStore: MarketStore = {
  existing: () =>
    db.market.findMany({ select: { id: true, venueMarketId: true, perpetualId: true, logoUrl: true } }),
  async save(id, data) {
    await db.market.upsert({ where: { id }, update: data, create: { id, ...data } });
  },
  async releaseVenueIds(venueMarketId, perpetualId, keepId) {
    await db.$executeRaw`
      UPDATE markets
      SET venue_market_id = -ABS(venue_market_id) - 1, perpetual_id = -ABS(perpetual_id) - 1, status = 'OFFLINE'
      WHERE (venue_market_id = ${venueMarketId} OR perpetual_id = ${perpetualId}) AND laxu_market <> ${keepId}
    `;
  },
  async markOfflineExcept(ids) {
    const result = await db.market.updateMany({
      where: { id: { notIn: ids }, status: { not: "OFFLINE" } },
      data: { status: "OFFLINE" },
    });
    return result.count;
  },
};

/// "eth-usd" / "ETHUSD" / "ETH" -> "ETH".
export function baseAssetOf(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  const stripped = upper.replace(/-?USD$/, "");
  return stripped.length > 0 ? stripped : upper;
}

/// (mrk - prv) / prv as a decimal fraction ("-0.0226"), 8 places.
export function priceChange(mark?: number, previous?: number): string {
  if (!mark || !previous || previous <= 0) return "0";
  const units = ((BigInt(mark) - BigInt(previous)) * 10n ** 8n) / BigInt(previous);
  return formatDecimal({ units, scale: 8 });
}

export function toMarketData(m: ApiMarket, onChain: OnChainCheck = { ok: true }): MarketData {
  const base = baseAssetOf(m.symbol);
  const pd = m.config.price_decimals;
  const sd = m.config.size_decimals;
  const initialMarginFraction = marginFraction(m.config.initial_margin) === "0" ? "1" : marginFraction(m.config.initial_margin);
  const step = stepOf(sd);
  return {
    venueMarketId: m.id,
    perpetualId: m.perpetual_id,
    displaySymbol: `${base}-USD`,
    baseAsset: base,
    fullAssetName: m.name || base,
    assetClass: "CRYPTO",
    status: m.config.is_open && onChain.ok ? "ONLINE" : "OFFLINE",
    logoUrl: m.icon || null,
    initialMarginFraction,
    offHoursInitialMarginFraction: initialMarginFraction,
    isOutsideRth: false,
    priceDecimals: pd,
    sizeDecimals: sd,
    orderTtlBlocks: m.order_ttl_blocks,
    maxSlippageBps: m.order_max_market_slippage_bps,
    takerFeeMicros: m.config.taker_fee,
    minPostingAmount: String(m.config.min_posting_amount ?? "0"),
    tickSize: stepOf(pd),
    stepSize: step,
    minOrderSize: step,
    maxOrderSize: "0",
    minOrderNotional: "0",
    maintenanceMarginFraction: marginFraction(m.config.maintenance_margin),
    markPrice: m.state?.mrk ? pnsToDecimal(m.state.mrk, pd) : "0",
    priceChange24h: priceChange(m.state?.mrk, m.state?.prv),
  };
}

export async function syncMarkets(deps: SyncDeps = defaultDeps()): Promise<{ synced: number; offline: number }> {
  const context = await deps.fetchContext();
  const markets = context.markets ?? [];
  // An empty answer is far more likely a Perpl hiccup than every market
  // delisting at once -- don't take the whole table OFFLINE over it.
  if (markets.length === 0) throw new Error("Perpl returned no markets");

  const existing = new Map((await deps.store.existing()).map((row) => [row.id, row]));
  const liveIds: string[] = [];

  for (const m of markets) {
    const base = baseAssetOf(m.symbol);
    const id = marketIdFor(base);
    // The id is the base asset, so two markets on one asset would fight over a
    // row. Keep the first rather than flap between them.
    if (liveIds.includes(id)) {
      log.warn("second market for the same base asset skipped", { baseAsset: base, market: m.symbol });
      continue;
    }
    liveIds.push(id);

    try {
      // A failed read keeps the market OFFLINE this pass rather than unsaved.
      const onChain = await deps.checkOnChain(m, id).catch((error): OnChainCheck => {
        log.warn("on-chain market check failed; OFFLINE this pass", { market: m.symbol, ...errorFields(error) });
        return { ok: false, reason: "on-chain check failed" };
      });
      const data = toMarketData(m, onChain);
      const row = existing.get(id);
      // Keep a logo we already have when Perpl's answer has none.
      if (!data.logoUrl && row?.logoUrl) data.logoUrl = row.logoUrl;
      if (row?.venueMarketId !== m.id || row?.perpetualId !== m.perpetual_id) {
        await deps.store.releaseVenueIds(m.id, m.perpetual_id, id);
      }
      await deps.store.save(id, data);
    } catch (error) {
      log.error("market sync failed for one market", { market: m.symbol, ...errorFields(error) });
    }
  }

  const offline = await deps.store.markOfflineExcept(liveIds);
  if (offline > 0) log.warn("markets no longer listed on Perpl marked OFFLINE", { count: offline });
  return { synced: liveIds.length, offline };
}

// ---------------------------------------------------------------------------
// On-chain checks
// ---------------------------------------------------------------------------

/// Decimals checks that passed, by perpetual id -- once per process.
const decimalsOk = new Set<number>();
/// Decimal mismatches already alerted, so a broken market alerts once.
const decimalsAlerted = new Set<number>();
/// Markets PerplReader maps. Set-once on-chain, so a `true` is cached; a
/// `false` is re-read every sync (the owner may map it later).
const mapped = new Set<string>();

export async function checkOnChain(m: ApiMarket, laxuMarket: string): Promise<OnChainCheck> {
  if (!decimalsOk.has(m.perpetual_id)) {
    const info = await getPerpetualInfo(BigInt(m.perpetual_id));
    if (Number(info.priceDecimals) !== m.config.price_decimals || Number(info.lotDecimals) !== m.config.size_decimals) {
      const reason = `API decimals (price ${m.config.price_decimals}, size ${m.config.size_decimals}) differ from on-chain (price ${info.priceDecimals}, lot ${info.lotDecimals})`;
      if (!decimalsAlerted.has(m.perpetual_id)) {
        decimalsAlerted.add(m.perpetual_id);
        alert("Perpl market decimals mismatch; market kept OFFLINE", { market: m.symbol, perpetualId: m.perpetual_id, reason });
      }
      return { ok: false, reason };
    }
    decimalsOk.add(m.perpetual_id);
  }

  if (!mapped.has(laxuMarket)) {
    const isMapped = (await publicClient().readContract({
      address: readerAddress() as Address,
      abi: perplReaderAbi,
      functionName: "isMapped",
      args: [symbolToBytes32(baseAssetOf(m.symbol)) as `0x${string}`],
    })) as boolean;
    if (!isMapped) return { ok: false, reason: "not mapped in PerplReader" };
    mapped.add(laxuMarket);
  }
  return { ok: true };
}

function defaultDeps(): SyncDeps {
  return {
    fetchContext: getContext,
    checkOnChain,
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
