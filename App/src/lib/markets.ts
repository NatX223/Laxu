"use client";

import { useEffect, useSyncExternalStore } from "react";
import { apiFetch } from "./api";
import { env } from "./env";
import { fetchContext, type PerplContextMarket } from "./perplMarketData";

/** One market: the backend's row (`GET /markets`) joined with Perpl's own market config. */
export type LaxuMarket = {
  /** bytes32 id — what every position stores as its market. */
  id: string;
  /** "ETH-USD" */
  displaySymbol: string;
  /** "ETH" — the key the trade screen uses. */
  baseAsset: string;
  fullAssetName: string;
  assetClass: "CRYPTO" | string;
  status: "ONLINE" | "OFFLINE" | string;
  /** Null → draw a letter avatar. */
  logoUrl: string | null;
  markPrice: string;
  /** Fraction, e.g. "0.0509" = +5.09%. */
  priceChange24h: string;
  /** Perpl's real limit for the market: `min(20, initial_margin / 100)`. Never a design number. */
  maxLeverage: number;
  stepSize: string;
  minOrderSize: string;
  minOrderNotional: string;
  /** Perpl's API market id: what its candles, book and trades endpoints take. */
  venueMarketId: number;
  /** Perpl's on-chain perpetual id. */
  perpetualId: number;
  /** Prices on the wire are integers scaled by this. */
  priceDecimals: number;
  /** Sizes on the wire are integers scaled by this. */
  sizeDecimals: number;
  /** Perpl's base taker fee as a fraction of notional, e.g. 0.000345 = 0.0345%. */
  takerFee: number;
  /** Fraction per funding interval, e.g. 0.0004 = 0.04% (positive: longs pay shorts). Null when Perpl gave none. */
  fundingRate: number | null;
  fundingIntervalSec: number | null;
  /** ms since epoch of the next funding event, from the last one plus the interval. */
  nextFundingAt: number | null;
};

/** What `GET /markets` carries; the rest comes from Perpl's context. */
type BackendMarket = Pick<
  LaxuMarket,
  | "id"
  | "displaySymbol"
  | "baseAsset"
  | "fullAssetName"
  | "assetClass"
  | "status"
  | "logoUrl"
  | "markPrice"
  | "priceChange24h"
  | "maxLeverage"
  | "stepSize"
  | "minOrderSize"
  | "minOrderNotional"
> & { venueMarketId: number };

/** LendingPool's risk tiers stop at 20x. Mirrors Backend/src/venue/perpl/units.ts. */
const LAXU_MAX_LEVERAGE = 20;

/** Perpl's `initial_margin` is the market's maximum leverage in hundredths (1200 = 12x). */
const leverageOf = (initialMargin: number) =>
  Math.max(1, Math.min(LAXU_MAX_LEVERAGE, Math.floor(initialMargin / 100)));

/**
 * Perpl's `FundingEvent.rate` is in micros (10^-6) per funding interval: 40 means
 * 0.004%. Checked on testnet: `ppl` = idx x rate / 10^6 for every market (this
 * used to divide by 100k, showing funding 10x too high).
 */
const fundingFraction = (rate: number | undefined) => (rate === undefined ? null : rate / 1_000_000);

function stepOf(decimals: number): string {
  return decimals <= 0 ? "1" : `0.${"0".repeat(decimals - 1)}1`;
}

/** Perpl's `config` and `funding` for one market, in the shape the joined row needs. */
function venueFields(m: PerplContextMarket): Pick<
  LaxuMarket,
  "venueMarketId" | "perpetualId" | "priceDecimals" | "sizeDecimals" | "takerFee" | "fundingRate" | "fundingIntervalSec" | "nextFundingAt"
> {
  const last = m.funding?.at?.t;
  return {
    venueMarketId: m.id,
    perpetualId: m.perpetual_id,
    priceDecimals: m.config.price_decimals,
    sizeDecimals: m.config.size_decimals,
    // `taker_fee` is in millionths of notional (1000 = 0.1%)
    takerFee: m.config.taker_fee / 1_000_000,
    fundingRate: fundingFraction(m.funding?.rate),
    fundingIntervalSec: m.funding_interval_sec || null,
    nextFundingAt: last && m.funding_interval_sec ? last + m.funding_interval_sec * 1000 : null,
  };
}

/** The same mapping the backend's market sync applies to `GET /v1/pub/context`. */
function fromContext(m: PerplContextMarket): LaxuMarket {
  const base = m.symbol.trim().toUpperCase().replace(/-?USD$/, "") || m.symbol.toUpperCase();
  const mark = m.state?.mrk ? m.state.mrk / 10 ** m.config.price_decimals : 0;
  const prev = m.state?.prv ? m.state.prv / 10 ** m.config.price_decimals : 0;
  const step = stepOf(m.config.size_decimals);
  return {
    id: base,
    displaySymbol: `${base}-USD`,
    baseAsset: base,
    fullAssetName: m.name || base,
    assetClass: "CRYPTO",
    status: m.config.is_open ? "ONLINE" : "OFFLINE",
    // Perpl's `icon` is empty on testnet: the letter avatar stands in.
    logoUrl: m.icon || null,
    markPrice: mark > 0 ? String(mark) : "0",
    priceChange24h: mark > 0 && prev > 0 ? String((mark - prev) / prev) : "0",
    maxLeverage: leverageOf(m.config.initial_margin),
    stepSize: step,
    minOrderSize: step,
    minOrderNotional: "0",
    ...venueFields(m),
  };
}

let warnedFallback = false;

/**
 * The market list. `GET /markets` from the backend, joined with Perpl's
 * context for decimals, ids and funding. When the backend can't be reached
 * (not running, wrong NEXT_PUBLIC_API_URL) the list is built from
 * `GET {perplApiUrl}/v1/pub/context` directly, mapped the way the backend maps
 * it — which only works where Perpl allows this origin; elsewhere that throws
 * too and the screens show an error state rather than an invented list. The
 * backend still enforces the real limits when a position opens.
 */
export async function getMarkets(): Promise<LaxuMarket[]> {
  try {
    const [rows, context] = await Promise.all([apiFetch<BackendMarket[]>("/markets"), fetchContext()]);
    const byId = new Map(context.markets.map((m) => [m.id, m]));
    return rows.flatMap((row): LaxuMarket[] => {
      const venue = byId.get(row.venueMarketId);
      // A market Perpl no longer lists can't be charted or priced: leave it out.
      return venue ? [{ ...row, ...venueFields(venue) }] : [];
    });
  } catch (error) {
    // an HTTP error from a live backend is real; a network failure is the fallback's cue
    if (!(error instanceof TypeError)) throw error;
    if (!warnedFallback) {
      warnedFallback = true;
      console.warn(`Laxu backend unreachable at ${env.apiUrl}; reading markets from Perpl directly`);
    }
    const context = await fetchContext(undefined, env.perplApiUrl);
    return context.markets
      .filter((m) => m.config.is_open)
      .map(fromContext)
      .sort((a, b) => a.displaySymbol.localeCompare(b.displaySymbol));
  }
}

// --- shared store ------------------------------------------------------------
// One copy of the market list for the whole app, so the selector, the ticket,
// the discovery cards and the position header all agree on icons and limits.

let markets: LaxuMarket[] = [];
let byBase = new Map<string, LaxuMarket>();
let failed = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((fn) => fn());

/** Refetch now. Concurrent calls share one request. */
export function refreshMarkets(): Promise<void> {
  inflight ??= getMarkets()
    .then((list) => {
      markets = list;
      byBase = new Map(list.map((m) => [m.baseAsset.toUpperCase(), m]));
      failed = false;
      emit();
    })
    .catch((error) => {
      console.error("could not load markets", error);
      // keep what is on screen; only say so when there is nothing to show
      if (!failed) {
        failed = true;
        emit();
      }
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  // the first subscriber triggers the first load
  if (markets.length === 0) void refreshMarkets();
  return () => {
    listeners.delete(fn);
  };
}

const EMPTY: LaxuMarket[] = [];

/** The live list; empty until the first load lands. */
export function useMarkets(): LaxuMarket[] {
  return useSyncExternalStore(
    subscribe,
    () => markets,
    () => EMPTY,
  );
}

/** True when the last load failed and there is no list to show: the screens say so instead of staying blank. */
export function useMarketsError(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => failed && markets.length === 0,
    () => false,
  );
}

/** Refetch on mount and every `ms` while mounted. Marks are live elsewhere (market state), so a minute is plenty. */
export function useMarketRefresh(ms = 60_000) {
  useEffect(() => {
    void refreshMarkets();
    const id = setInterval(() => void refreshMarkets(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** The list as of now, outside React (render code re-runs via useMarkets). */
export const currentMarkets = () => markets;

/** By base asset ("ETH") or display symbol ("ETH-USD"). */
export function marketFor(symbol: string | null | undefined): LaxuMarket | undefined {
  if (!symbol) return undefined;
  const upper = symbol.toUpperCase();
  return byBase.get(upper) ?? byBase.get(upper.replace(/-USD$/, ""));
}

/** The market the trade screen opens on, and falls back to for a symbol Perpl doesn't list: ETH when it exists, else the first. */
export function defaultMarketSymbol(): string | undefined {
  return (byBase.get("ETH") ?? markets[0])?.baseAsset;
}

// --- display helpers ---------------------------------------------------------

/** A stable colour per symbol, for the letter avatar. */
export function colorFromString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 62% 64%)`;
}
