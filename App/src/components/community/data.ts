/**
 * The community market's rows, mapped from the backend's discovery cards
 * (`GET /positions`), plus the formatters and geometry from
 * `Laxu Community.dc.html`.
 */

import type { DiscoveryCard } from "@/lib/api";

export type Kind = "crypto" | "stock" | "index" | "commodity";

const KIND_OF: Record<NonNullable<DiscoveryCard["market"]["assetClass"]>, Kind> = {
  CRYPTO: "crypto",
  EQUITIES: "stock",
  INDICES: "index",
  COMMODITIES: "commodity",
};

export const fmtUsd = (n: number) =>
  n >= 1000000
    ? "$" + (n / 1000000).toFixed(n >= 10000000 ? 1 : 2) + "M"
    : n >= 1000
      ? "$" + (n / 1000).toFixed(1) + "K"
      : "$" + n.toFixed(2);

export const fmtNum = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(Math.round(n)));

export type Token = {
  /** The position token's address -- the row's identity and its page. */
  address: string;
  /** Underlying market's base asset, e.g. "TSLA". */
  sym: string;
  /** The creator's nickname for the position; may be empty. */
  name: string;
  kind: Kind | null;
  accent: string;
  logo: string;
  long: boolean;
  lev: number;
  /** NAV per token, USDG. */
  price: number;
  /** PnL since entry, percent. */
  chg: number;
  /** All-time buy-in volume, USDG. */
  vol: number;
  holders: number;
  /** size × mark, USD; 0 until the first report. */
  notional: number;
  creator: string;
  /** ms since epoch */
  createdAt: number;
  /** The sparkline reads this token's real NAV history. */
  positionTokenAddress: string;
};

const num = (s: string | null | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

export function fromCard(c: DiscoveryCard): Token {
  const long = c.direction !== "short";
  return {
    address: c.address,
    sym: c.market.baseAsset,
    name: c.nickname,
    kind: c.market.assetClass ? KIND_OF[c.market.assetClass] : null,
    accent: long ? "#5fe3a8" : "#ff7d92",
    logo: c.market.logoUrl ?? "",
    long,
    lev: c.leverage,
    price: num(c.navPerShare),
    chg: num(c.pnlPct),
    vol: num(c.buyInVolume),
    holders: c.holderCount,
    notional: Math.abs(num(c.size)) * num(c.markPrice),
    creator: c.creator.tag ? "@" + c.creator.tag : c.creator.address.slice(0, 6) + "…" + c.creator.address.slice(-4),
    createdAt: Date.parse(c.createdAt) || 0,
    positionTokenAddress: c.address,
  };
}

/** One layer of the hero's stacked wave field, in a 1200×300 viewBox. */
export function wave(seed: number, amp: number, yBase: number, close: boolean) {
  const pts: string[] = [];
  for (let i = 0; i <= 64; i++) {
    const x = (i / 64) * 1200;
    const p = (i / 64) * Math.PI * 2;
    const y =
      yBase -
      amp *
        (Math.sin(p * 1.6 + seed) * 0.6 +
          Math.sin(p * 3.3 + seed * 1.7) * 0.28 +
          Math.sin(p * 6.1 + seed * 2.4) * 0.12);
    pts.push(x.toFixed(1) + "," + y.toFixed(1));
  }
  const line = "M" + pts.join(" L");
  return close ? line + " L1200,300 L0,300 Z" : line;
}

export const SORTS = [
  ["vol", "Highest volume"],
  ["perf", "Best PnL"],
  ["holders", "Most holders"],
  ["notional", "Largest notional"],
  ["new", "Newest mints"],
] as const;

export const KINDS = [
  ["all", "All"],
  ["crypto", "Crypto"],
  ["stock", "Stocks"],
  ["index", "Indices"],
  ["commodity", "Commodities"],
] as const;

export type SortKey = (typeof SORTS)[number][0];
export type KindKey = (typeof KINDS)[number][0];
