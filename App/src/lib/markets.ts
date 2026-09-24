"use client";

import { useEffect, useSyncExternalStore } from "react";
import { apiFetch } from "./api";
import { env } from "./env";

/** One market as `GET /markets` returns it. Decimals are strings. */
export type LaxuMarket = {
  /** bytes32 id — what every position stores as its market. */
  id: string;
  /** "ETH-USD" */
  displaySymbol: string;
  /** "ETH" — the key the trade screen uses. */
  baseAsset: string;
  fullAssetName: string;
  assetClass: "CRYPTO" | "EQUITIES" | "COMMODITIES" | "INDICES" | string;
  status: "ONLINE" | "OFFLINE" | string;
  /** Null → draw a letter avatar. */
  logoUrl: string | null;
  markPrice: string;
  /** Fraction, e.g. "0.0509" = +5.09%. */
  priceChange24h: string;
  /** The limit right now. */
  maxLeverage: number;
  maxLeverageInHours: number;
  maxLeverageOffHours: number;
  isOutsideRth: boolean;
  /** Null for 24/7 markets. */
  tradingHours: { start: string; end: string; timezone: string } | null;
  stepSize: string;
  minOrderSize: string;
  minOrderNotional: string;
};

/**
 * `GET /markets` from the backend. When the backend can't be reached (not
 * running, wrong NEXT_PUBLIC_API_URL) the list comes straight from Arcus
 * instead, with the same leverage rule applied here — so the selector never
 * goes empty just because the backend is down. The backend still enforces the
 * real limits when a position opens.
 */
export async function getMarkets(): Promise<LaxuMarket[]> {
  try {
    return await apiFetch<LaxuMarket[]>("/markets");
  } catch (error) {
    if (!(error instanceof TypeError)) throw error; // an HTTP error from a live backend is real
    if (!warnedFallback) {
      warnedFallback = true;
      console.warn(`Laxu backend unreachable at ${env.apiUrl}; reading markets from Arcus directly`);
    }
    return getArcusMarkets();
  }
}
let warnedFallback = false;

// --- direct-from-Arcus fallback ---------------------------------------------
// Mirrors Backend/src/services/markets.ts — keep the two in step.

const LAXU_MAX_LEVERAGE = 20;

function leverageFor(imf: string | undefined): number {
  const fraction = Number(imf);
  if (!Number.isFinite(fraction) || fraction <= 0) return 1;
  // +1e-9 guards float error: 1/0.04 is 24.999…
  return Math.max(1, Math.min(LAXU_MAX_LEVERAGE, Math.floor(1 / fraction + 1e-9)));
}

const clock = (secondsOfDay: number) => {
  const minutes = Math.floor(secondsOfDay / 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};

type ArcusMarket = {
  marketDisplayName: string;
  fullAssetName?: string;
  baseAsset: string;
  category?: string;
  status: string;
  markPrice?: string;
  oraclePrice?: string;
  priceChange24h?: string;
  initialMarginFraction?: string;
  offHoursInitialMarginFraction?: string;
  isOutsideRth?: boolean;
  regularTradingHours?: { startSecondsOfDay: number; endSecondsOfDay: number; timezone: string } | null;
  stepSize: string;
  minOrderSize: string;
  minOrderNotional?: string;
};

async function getArcusMarkets(): Promise<LaxuMarket[]> {
  const res = await fetch(`${env.arcusApiUrl}/v1/markets`);
  if (!res.ok) throw new Error(`Arcus markets ${res.status}`);
  const { markets: list } = (await res.json()) as { markets: ArcusMarket[] };
  return list
    .filter((m) => m.status === "ONLINE")
    .map((m): LaxuMarket => {
      const inHours = leverageFor(m.initialMarginFraction);
      const offHours = leverageFor(m.offHoursInitialMarginFraction ?? m.initialMarginFraction);
      const hours = m.regularTradingHours;
      return {
        id: m.baseAsset, // not the bytes32 id — nothing in the fallback path needs it
        displaySymbol: m.marketDisplayName,
        baseAsset: m.baseAsset,
        fullAssetName: m.fullAssetName ?? m.baseAsset,
        assetClass: m.category ?? "OTHER",
        status: m.status,
        // No HEAD check here: MarketIcon's onError falls back to the letter avatar.
        logoUrl: `${env.arcusBrandingUrl}/markets/branding/${m.baseAsset}.png`,
        markPrice: m.markPrice && m.markPrice !== "0" ? m.markPrice : (m.oraclePrice ?? "0"),
        priceChange24h: m.priceChange24h ?? "0",
        maxLeverage: m.isOutsideRth ? offHours : inHours,
        maxLeverageInHours: inHours,
        maxLeverageOffHours: offHours,
        isOutsideRth: m.isOutsideRth ?? false,
        tradingHours: hours
          ? { start: clock(hours.startSecondsOfDay), end: clock(hours.endSecondsOfDay), timezone: hours.timezone }
          : null,
        stepSize: m.stepSize,
        minOrderSize: m.minOrderSize,
        minOrderNotional: m.minOrderNotional ?? "0",
      };
    })
    .sort((a, b) => a.assetClass.localeCompare(b.assetClass) || a.displaySymbol.localeCompare(b.displaySymbol));
}

// --- shared store ------------------------------------------------------------
// One copy of the market list for the whole app, so the selector, the ticket,
// the discovery cards and the position header all agree on icons and limits.

let markets: LaxuMarket[] = [];
let byBase = new Map<string, LaxuMarket>();
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Refetch now. Concurrent calls share one request. */
export function refreshMarkets(): Promise<void> {
  inflight ??= getMarkets()
    .then((list) => {
      markets = list;
      byBase = new Map(list.map((m) => [m.baseAsset.toUpperCase(), m]));
      listeners.forEach((fn) => fn());
    })
    .catch((error) => console.error("could not load markets", error))
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

/** Refetch on mount and every `ms` while mounted — the selector's cadence. */
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

// --- display helpers ---------------------------------------------------------

/** A stable colour per symbol, for the letter avatar. */
export function colorFromString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 62% 64%)`;
}

const TZ_ABBR: Record<string, string> = { "America/New_York": "ET" };

/**
 * "Up to 10x during market hours (04:00–20:00 ET), 6x outside." plus which one
 * applies now. Null for 24/7 markets, or where the two limits are the same.
 */
export function hoursHint(m: LaxuMarket): { text: string; now: string } | null {
  if (!m.tradingHours || m.maxLeverageInHours === m.maxLeverageOffHours) return null;
  const { start, end, timezone } = m.tradingHours;
  return {
    text: `Up to ${m.maxLeverageInHours}x during market hours (${start}–${end} ${TZ_ABBR[timezone] ?? timezone}), ${m.maxLeverageOffHours}x outside.`,
    now: m.isOutsideRth ? "Outside market hours now." : "Market hours now.",
  };
}
