"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import type { PublicPosition } from "@/lib/api";
import { publicClient } from "@/lib/chain";
import { compact, usd } from "./data";
import type { Stat } from "./derive";

/**
 * The position token's own figures, read straight off the contract — what the
 * header and the state grid show for a minted position instead of the
 * prototype's sample numbers.
 */

const POLL_MS = 15_000;
const PRICE_SCALE = 1e18;
/** `size` is the base asset at 6 dp; capital, funding and totalAssets are USDG base units. */
const SIZE_SCALE = 1e6;
const USDG_SCALE = 1e6;

const tokenAbi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "entryPrice", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "markPrice", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "size", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "fundingAccrued", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "int256" }] },
  { type: "function", name: "lastReportTimestamp", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalAssets", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "navPerShare", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

/** Human numbers: prices and NAV in USD, size in the base asset, funding in USDG (positive = received). */
export type TokenState = {
  ticker: string;
  entry: number;
  mark: number;
  size: number;
  funding: number;
  /** unix seconds; 0 before the first report */
  lastReport: number;
  totalAssets: number;
  supply: number;
  navPerToken: number;
};

async function readTokenState(token: Address): Promise<TokenState> {
  const read = <T>(functionName: (typeof tokenAbi)[number]["name"]) =>
    publicClient().readContract({ address: token, abi: tokenAbi, functionName } as never) as Promise<T>;
  const [ticker, entry, mark, size, funding, lastReport, totalAssets, supply, nav] = await Promise.all([
    read<string>("symbol"),
    read<bigint>("entryPrice"),
    read<bigint>("markPrice"),
    read<bigint>("size"),
    read<bigint>("fundingAccrued"),
    read<bigint>("lastReportTimestamp"),
    read<bigint>("totalAssets"),
    read<bigint>("totalSupply"),
    read<bigint>("navPerShare"),
  ]);
  return {
    ticker,
    entry: Number(entry) / PRICE_SCALE,
    mark: Number(mark) / PRICE_SCALE,
    size: Number(size) / SIZE_SCALE,
    funding: Number(funding) / USDG_SCALE,
    lastReport: Number(lastReport),
    totalAssets: Number(totalAssets) / USDG_SCALE,
    // the token's decimals are USDG's
    supply: Number(supply) / USDG_SCALE,
    navPerToken: Number(nav) / PRICE_SCALE,
  };
}

/** Polled, so the mark, funding and NAV follow the operator's reports. */
export function useTokenState(token: string | undefined): TokenState | null {
  const [state, setState] = useState<{ token: string; value: TokenState } | null>(null);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const load = () =>
      readTokenState(token as Address)
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
  }, [token]);
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
  const base = live.symbol ?? live.arcusMarket?.split("-")[0] ?? "";
  const side = live.direction === "long" ? "Long" : "Short";
  const dash = "—";

  // NAV starts at 1.0 per token; the whole position's P&L is the move times the supply.
  const navPct = chain ? (chain.navPerToken - 1) * 100 : 0;
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
    lastReport: chain?.lastReport ? `${ago(chain.lastReport)} ago` : dash,
    stats,
    isCreator,
  };
}
