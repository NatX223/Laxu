import { colorFromString, currentMarkets, defaultMarketSymbol, marketFor, type LaxuMarket } from "@/lib/markets";

/**
 * Market catalogue + formatters for the trade screen.
 *
 * The market list is the live one (`GET /markets` joined with Perpl's own
 * config, via lib/markets): name, mark, leverage limit and decimals all come
 * from there. This file only adds presentation (tint, ink, logo) for the
 * symbols Perpl lists; any other symbol gets a colour from its name. Nothing
 * here is a market figure: volume, open interest and funding are read live
 * (see stats.ts) and show "—" when Perpl hasn't said.
 */

export type MarketCat = "Crypto" | "Equities" | "Commodities" | "Indices";

export type Market = {
  name: string;
  kind: string;
  cat: MarketCat;
  /** used in the market-info blurb: "the {noun} price" */
  noun: string;
  /** Perpl's real leverage limit for the market; 0 until the live list has loaded (the ticket is then disabled). */
  lev: number;
  tint: string;
  ink: string;
  logo?: string;
  /** "ETH-USD" */
  displaySymbol: string;
  /** The live market; undefined until the list has loaded. */
  live?: LaxuMarket;
};

type Look = { tint: string; ink: string; logo?: string };

/** Presentation only, for the markets Perpl lists on testnet. */
const LOOK: Record<string, Look> = {
  BTC: { tint: "#f7931a", ink: "#16130f" },
  ETH: { tint: "#ff8a3d", ink: "#16130f", logo: "/laxu/logo-eth.png" },
  SOL: { tint: "#14f195", ink: "#00291a" },
  MON: { tint: "#836ef9", ink: "#fdfbf7" },
  ZEC: { tint: "#f4b728", ink: "#16130f" },
  LIT: { tint: "#e8c15a", ink: "#16130f" },
  PUMP: { tint: "#3ddc97", ink: "#04261a" },
  NEAR: { tint: "#00ec97", ink: "#00261a" },
};

const CAT_OF: Record<string, MarketCat> = {
  CRYPTO: "Crypto",
  EQUITIES: "Equities",
  COMMODITIES: "Commodities",
  INDICES: "Indices",
};
const KIND_OF: Record<MarketCat, [kind: string, noun: string]> = {
  Crypto: ["CRYPTO PERP", "crypto asset"],
  Equities: ["EQUITY PERP", "equity"],
  Commodities: ["COMMODITY PERP", "commodity"],
  Indices: ["INDEX PERP", "index"],
};

/** Every tradeable symbol: the live list. Empty until it loads. */
export const syms = (): string[] => currentMarkets().map((m) => m.baseAsset);

/**
 * The market for `sym`. A symbol Perpl doesn't list resolves to the default
 * market (ETH when it exists, else the first), so the screen never lands on
 * something that isn't there. Before the list loads there is no market at
 * all: a placeholder with `live` unset and a leverage limit of 0.
 */
export const cat = (sym: string): Market => {
  const live = marketFor(sym) ?? marketFor(defaultMarketSymbol());
  if (!live) {
    return { name: sym, kind: "CRYPTO PERP", cat: "Crypto", noun: "crypto asset", lev: 0, tint: colorFromString(sym), ink: "#16130f", displaySymbol: `${sym}-USD` };
  }
  const category = CAT_OF[live.assetClass] ?? "Crypto";
  const [kind, noun] = KIND_OF[category];
  const look = LOOK[live.baseAsset];
  return {
    kind,
    noun,
    name: live.fullAssetName,
    cat: category,
    lev: live.maxLeverage,
    tint: look?.tint ?? colorFromString(live.baseAsset),
    ink: look?.ink ?? "#16130f",
    logo: live.logoUrl ?? look?.logo,
    displaySymbol: live.displaySymbol,
    live,
  };
};

/** The categories that have at least one market, "All" first. Perpl lists crypto only. */
export const categoriesOf = (markets: LaxuMarket[]): string[] => [
  "All",
  ...new Set(markets.map((m) => CAT_OF[m.assetClass] ?? "Crypto")),
];

export const money = (n: number, d = 2) =>
  "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export function volFmt(n: number) {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1e6) return (v / 1e6).toFixed(2) + " M";
  if (v >= 1e3) return (v / 1e3).toFixed(2) + " K";
  return String(Math.round(v));
}

/** "$10.25M", "$1.4B", "$512K"; a dash for anything Perpl didn't report. */
export function compactUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const v = Math.abs(n);
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  return "$" + v.toFixed(0);
}

export function kmoney(n: number) {
  const v = Math.abs(Number(n));
  if (v >= 1000) return "$" + (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k";
  return "$" + Math.round(v);
}

export type Side = "long" | "short";

/** One of the signed-in user's own minted positions (`GET /positions/mine`). */
export type Position = {
  id: string;
  sym: string;
  side: Side;
  lev: number;
  /** Base-asset size. */
  qty: number;
  entry: number;
  /** The asset the creator put in. */
  margin: number;
  /** PositionToken address. */
  addr: string;
  /** Null while the backend is still creating it. */
  pool: string | null;
  nickname: string;
  listed: boolean;
  status: "open" | "closed" | "settled";
  liquidated: boolean;
};

/** The chart's timeframe pills; each is one of Perpl's supported candle resolutions. */
export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1D"] as const;
export const RANGES = ["5y", "1y", "6m", "3m", "1m", "5d", "1d"] as const;
/** Perpl lists perpetuals only. */
export const MARKET_TABS = ["Perpetuals"] as const;
/** Quick sizes in the asset; the ticket adds MAX (the wallet's balance) after these. */
export const SIZE_CHIPS = [25, 50, 100];

/** Below this width the market-info panel collapses regardless of `infoOpen`. */
export const INFO_MIN_WIDTH = 1180;
