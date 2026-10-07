"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { positionTokenAbi } from "@/lib/abi.generated";
import type { PublicPosition } from "@/lib/api";
import { useAsset } from "@/lib/asset";
import { publicClient } from "@/lib/chain";
import { compact, usd } from "./data";
import type { Stat } from "./derive";

/**
 * The position token's own figures, read straight off the contract — what the
 * header and the state grid show for a minted position instead of the
 * prototype's sample numbers. The mark is the token's own on-chain read of
 * Perpl's price (`currentMark()`): Laxu's backend cannot set it.
 */

const POLL_MS = 15_000;
const PRICE_SCALE = 1e18;
/** `size` is the base asset at 6 dp, whatever the market's own lot size. */
const SIZE_SCALE = 1e6;
/** PositionToken.ENTRY_TOLERANCE_BPS: the entry may differ from Perpl's by this much. */
const ENTRY_TOLERANCE_BPS = 50;

/** Our position next to Perpl's, from `venueDrift()`. Sizes in the base asset, entries in USD. */
export type VenueDrift = {
  ourSize: number;
  venueSize: number;
  ourEntry: number;
  venueEntry: number;
  /** False when Perpl has no open position for the slot's account. */
  venueExists: boolean;
  /** Size matches exactly and the entry is within 0.5%: what the token itself enforces at every fill. */
  verified: boolean;
};

/** Human numbers: prices and NAV in USD, size in the base asset, funding in the asset (positive = received). */
export type TokenState = {
  ticker: string;
  entry: number;
  /** Perpl's mark, read on-chain; the last known one when `markLive` is false. */
  mark: number;
  /** False when Perpl could not be read on-chain: `mark` is the last known value. */
  markLive: boolean;
  /** `isPriceFresh()`: a live mark and a funding update inside the token's age limits. */
  priceFresh: boolean;
  size: number;
  funding: number;
  /** unix seconds of the last funding update; 0 before the first */
  lastFunding: number;
  totalAssets: number;
  supply: number;
  navPerToken: number;
  /** NAV against its genesis 1.0, in percent (`currentPnLBps() / 100`). */
  pnlPct: number;
  closed: boolean;
  /** The slot's Perpl account id this position trades from. */
  venueAccountId: string;
  /** Null when the venue could not be read, or the position is closed. */
  drift: VenueDrift | null;
};

/** What the header says about where the mark came from, and why it can be trusted (or not right now). */
export type PriceSource = { label: string; tone: "good" | "warn"; tip: string };

const PRICE_TIP =
  "This position values itself by reading Perpl's mark price on-chain. Laxu's backend cannot set it.";

/** Live and fresh: green. Perpl unreachable: amber, last known mark. Live but the funding update lapsed: amber. */
export function priceSourceOf(chain: TokenState): PriceSource | null {
  if (chain.closed) return null;
  if (!chain.markLive) {
    return {
      label: "Mark: last known · Perpl unreachable",
      tone: "warn",
      tip: `${PRICE_TIP} Right now Perpl could not be read, so the last known mark is shown and borrowing is paused.`,
    };
  }
  if (!chain.priceFresh) {
    return {
      label: "Funding update overdue",
      tone: "warn",
      tip: `${PRICE_TIP} The mark is live, but the funding update is overdue, so borrowing is paused until it lands.`,
    };
  }
  return { label: "Mark: Perpl on-chain · live", tone: "good", tip: PRICE_TIP };
}

/**
 * The smallest buy-in that adds at least one lot: the added size is the
 * position's size times the net amount over its total value, and Perpl won't
 * trade less than `10^-sizeDecimals` of the base asset. Grossed up for the
 * buy-in fee (none for the creator) with a 5% buffer, rounded up to the cent.
 * Null when the position's value or size isn't known yet.
 */
export function minBuyIn(chain: TokenState | null, sizeDecimals: number | undefined, feeFraction: number): number | null {
  if (!chain || sizeDecimals === undefined || !(chain.size > 0) || !(chain.totalAssets > 0)) return null;
  const lot = 10 ** -sizeDecimals;
  const net = (lot * chain.totalAssets) / chain.size;
  return Math.ceil(((net / (1 - feeFraction)) * 1.05) * 100) / 100;
}

async function readTokenState(token: Address, decimals: number): Promise<TokenState> {
  const read = <T>(functionName: string) =>
    publicClient().readContract({ address: token, abi: positionTokenAbi, functionName } as never) as Promise<T>;
  const [ticker, entry, [mark, markLive], priceFresh, size, funding, lastFunding, totalAssets, supply, nav, pnlBps, closed, accountId, drift] =
    await Promise.all([
      read<string>("symbol"),
      read<bigint>("entryPrice"),
      read<readonly [bigint, boolean]>("currentMark"),
      read<boolean>("isPriceFresh"),
      read<bigint>("size"),
      read<bigint>("fundingAccrued"),
      read<bigint>("lastFundingTimestamp"),
      read<bigint>("totalAssets"),
      read<bigint>("totalSupply"),
      read<bigint>("navPerShare"),
      read<bigint>("currentPnLBps"),
      read<boolean>("closed"),
      read<bigint>("venueAccountId"),
      // A venue read can fail on its own; the rest of the page must not.
      read<readonly [bigint, bigint, bigint, bigint, boolean]>("venueDrift").catch(() => null),
    ]);
  const unit = 10 ** decimals;
  const entryNum = Number(entry) / PRICE_SCALE;
  let venue: VenueDrift | null = null;
  if (drift && !closed) {
    const [ourSize, venueSize, ourEntry, venueEntry, venueExists] = drift;
    const entryGap = ourEntry > BigInt(0) ? (ourEntry > venueEntry ? ourEntry - venueEntry : venueEntry - ourEntry) : BigInt(0);
    venue = {
      ourSize: Number(ourSize) / SIZE_SCALE,
      venueSize: Number(venueSize) / SIZE_SCALE,
      ourEntry: Number(ourEntry) / PRICE_SCALE,
      venueEntry: Number(venueEntry) / PRICE_SCALE,
      venueExists,
      verified:
        venueExists &&
        ourSize === venueSize &&
        entryGap * BigInt(10_000) <= ourEntry * BigInt(ENTRY_TOLERANCE_BPS),
    };
  }
  return {
    ticker,
    entry: entryNum,
    mark: Number(mark) / PRICE_SCALE,
    markLive,
    priceFresh,
    size: Number(size) / SIZE_SCALE,
    funding: Number(funding) / unit,
    lastFunding: Number(lastFunding),
    totalAssets: Number(totalAssets) / unit,
    // the token's decimals are the asset's
    supply: Number(supply) / unit,
    navPerToken: Number(nav) / PRICE_SCALE,
    pnlPct: Number(pnlBps) / 100,
    closed,
    venueAccountId: accountId.toString(),
    drift: venue,
  };
}

/** Polled, so the mark, funding and NAV follow the chain: Perpl's mark is read live, funding as it is reported. */
export function useTokenState(token: string | undefined): TokenState | null {
  const [state, setState] = useState<{ token: string; value: TokenState } | null>(null);
  const { decimals } = useAsset();
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const load = () =>
      readTokenState(token as Address, decimals)
        .then((value) => {
          if (!cancelled) setState({ token, value });
        })
        .catch((error) => console.error("could not read position token", error));
    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token, decimals]);
  return state && state.token === token ? state.value : null;
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** "34d", "5h", "12m", "40s" */
function ago(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s >= 86_400) return `${Math.floor(s / 86_400)}d`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

/** Enough digits to see a sub-dollar price move. */
const price = (n: number) => usd(n, n >= 10 ? 2 : 4);
const signedUsd = (n: number) => (n >= 0 ? "+" : "−") + usd(Math.abs(n)).slice(1);
const signedPct = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";

/**
 * The header's and state grid's values for a minted position, over the
 * prototype's. `chain` null means the token is still being read: every figure
 * shows a dash rather than a sample number.
 */
export function liveVals(live: PublicPosition, chain: TokenState | null, viewer: string | undefined) {
  const isCreator = Boolean(viewer) && viewer!.toLowerCase() === live.creator.toLowerCase();
  const base = live.symbol ?? live.venueMarket?.split("-")[0] ?? "";
  const side = live.direction === "long" ? "Long" : "Short";
  const dash = "—";

  // NAV starts at 1.0 per token; the whole position's P&L is the move times the supply.
  // The percentage is the token's own `currentPnLBps()`, so funding and fees are in it.
  const navPct = chain ? chain.pnlPct : 0;
  const pnlAbs = chain ? (chain.navPerToken - 1) * chain.supply : 0;
  const up = navPct >= 0;
  const pnlColor = up ? "#5fe3a8" : "#ff7d92";
  const markPct = chain && chain.entry ? (chain.mark / chain.entry - 1) * 100 : 0;

  const opened = live.openedAt ? `opened ${ago(live.openedAt)} ago` : "opening";
  const ageLabel = live.closedAt ? `closed ${ago(live.closedAt)} ago` : opened;

  const stats: Stat[] = [
    { k: "ENTRY", v: chain ? price(chain.entry) : dash, c: "#fdfbf7" },
    {
      k: "MARK",
      v: chain ? price(chain.mark) : dash,
      c: "#fdfbf7",
      sub: chain ? signedPct(markPct) + " vs entry" : undefined,
    },
    {
      k: "SIZE",
      v: chain ? `${chain.size.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${base}` : dash,
      c: "#fdfbf7",
      sub: chain ? compact(chain.size * chain.mark) + " notional" : undefined,
    },
    {
      k: "UNREALIZED PNL",
      v: chain ? signedPct(navPct) : dash,
      c: chain ? pnlColor : "#fdfbf7",
      sub: chain ? signedUsd(pnlAbs) : undefined,
    },
    {
      k: "FUNDING ACCRUED",
      v: chain ? signedUsd(chain.funding) : dash,
      c: chain && chain.funding < 0 ? "#ffb765" : "#fdfbf7",
      sub: chain ? (chain.funding < 0 ? "paid since open" : "received since open") : undefined,
    },
  ];

  return {
    nickname: live.nickname,
    structuredName: `${base} ${side} ${live.leverage}×`,
    ticker: chain?.ticker ?? dash,
    addr: shortAddr(live.positionTokenAddress),
    creator: isCreator ? "you" : shortAddr(live.creator),
    ageLabel,
    base,
    logo: live.logoUrl ?? "",
    navPrice: chain ? usd(chain.navPerToken, 4) : dash,
    navChg: chain ? signedPct(navPct) : "",
    navChgAbs: chain ? signedUsd(pnlAbs) : "",
    pnlColor,
    /** Where the mark came from, and whether it is fresh; null while loading or once closed. */
    priceSource: chain ? priceSourceOf(chain) : null,
    /** "funding updated 12m ago" -- when the backend last reported funding to the token. */
    fundingUpdated: chain?.lastFunding ? `${ago(chain.lastFunding)} ago` : dash,
    stats,
    isCreator,
  };
}
