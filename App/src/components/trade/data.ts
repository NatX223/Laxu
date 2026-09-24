import { colorFromString, currentMarkets, marketFor, type LaxuMarket } from "@/lib/markets";

/**
 * Market catalogue + formatters, transcribed from `Laxu Trade.dc.html`.
 * The prototype kept these on the component class (`CAT`, `money`, `vol`, …);
 * they are pure, so they live outside React here.
 *
 * The live market list (`GET /markets`, via lib/markets) is laid over this:
 * name, price, leverage limit and logo come from Arcus; the design's own
 * entries only still supply the display stats Arcus data doesn't cover.
 */

export type MarketCat = "Crypto" | "Equities" | "Commodities" | "Indices";

export type Market = {
  name: string;
  kind: string;
  cat: MarketCat;
  /** used in the market-info blurb: "the tokenized {noun} price" */
  noun: string;
  base: number;
  lev: number;
  tint: string;
  ink: string;
  logo?: string;
  isNew?: boolean;
  vol: string;
  fund: string;
  mcap: string;
  oi: string;
  tok: string;
  /** "ETH-USD"; the live market when the list has loaded. */
  displaySymbol: string;
  live?: LaxuMarket;
};

type DesignMarket = Omit<Market, "displaySymbol" | "live">;

export const MARKETS: Record<string, DesignMarket> = {
  TSLA: { name: "Tesla, Inc.", kind: "EQUITY PERP", cat: "Equities", noun: "equity", base: 431.2, lev: 10, tint: "#9670ff", ink: "#16130f", logo: "/laxu/logo-tsla.png", vol: "$263.4M", fund: "0.0091%", mcap: "$1.38T", oi: "$52.7M", tok: "412" },
  ETH: { name: "Ethereum", kind: "CRYPTO PERP", cat: "Crypto", noun: "crypto asset", base: 4943.8, lev: 20, tint: "#ff8a3d", ink: "#16130f", logo: "/laxu/logo-eth.png", vol: "$1.02B", fund: "0.0013%", mcap: "$594B", oi: "$184.2M", tok: "1,284" },
  BTC: { name: "Bitcoin", kind: "CRYPTO PERP", cat: "Crypto", noun: "crypto asset", base: 77519.5, lev: 40, tint: "#f7931a", ink: "#16130f", vol: "$338K", fund: "0.0013%", mcap: "$1.56T", oi: "$14.6M", tok: "906" },
  NVDA: { name: "NVIDIA Corp.", kind: "EQUITY PERP", cat: "Equities", noun: "equity", base: 186.4, lev: 10, tint: "#76b900", ink: "#0d1a00", vol: "$291K", fund: "0.0065%", mcap: "$4.52T", oi: "$18.9M", tok: "338" },
  CRCL: { name: "Circle Internet", kind: "EQUITY PERP", cat: "Equities", noun: "equity", base: 89.56, lev: 10, tint: "#4a9cf6", ink: "#04142b", isNew: true, vol: "$216K", fund: "0.0050%", mcap: "$22.7B", oi: "$3.61M", tok: "74" },
  XRP: { name: "Ripple", kind: "CRYPTO PERP", cat: "Crypto", noun: "crypto asset", base: 1.334, lev: 20, tint: "#8ea3bd", ink: "#0d1622", vol: "$400K", fund: "0.0975%", mcap: "$83.5B", oi: "$21.2M", tok: "512" },
  SOL: { name: "Solana", kind: "CRYPTO PERP", cat: "Crypto", noun: "crypto asset", base: 214.7, lev: 20, tint: "#14f195", ink: "#00291a", isNew: true, vol: "$188K", fund: "0.0210%", mcap: "$102B", oi: "$9.84M", tok: "221" },
  USO: { name: "Crude Oil Fund", kind: "COMMODITY PERP", cat: "Commodities", noun: "commodity", base: 159.7, lev: 20, tint: "#d9dde3", ink: "#16130f", vol: "$262K", fund: "0.0050%", mcap: "$18.5B", oi: "$7.63M", tok: "118" },
  GOLD: { name: "Gold Spot", kind: "COMMODITY PERP", cat: "Commodities", noun: "commodity", base: 3118.4, lev: 25, tint: "#ffd9a0", ink: "#3a2a08", vol: "$244K", fund: "0.0032%", mcap: "$21.4T", oi: "$11.2M", tok: "265" },
  QQQ: { name: "Nasdaq 100", kind: "INDEX PERP", cat: "Indices", noun: "index", base: 727.1, lev: 25, tint: "#5b7cfa", ink: "#040f2b", vol: "$233K", fund: "0.0050%", mcap: "$511B", oi: "$5.54M", tok: "143" },
  SPX: { name: "S&P 500", kind: "INDEX PERP", cat: "Indices", noun: "index", base: 6412.8, lev: 25, tint: "#a79bd0", ink: "#1c1638", vol: "$205K", fund: "0.0044%", mcap: "$49.8T", oi: "$8.12M", tok: "197" },
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

/** Every tradeable symbol: the live list once loaded, the design's before. */
export const syms = (): string[] => {
  const live = currentMarkets();
  return live.length ? live.map((m) => m.baseAsset) : Object.keys(MARKETS);
};

/** Unknown symbols fall back to TSLA, exactly as `cat()` did. */
export const cat = (sym: string): Market => {
  const live = marketFor(sym);
  const design = MARKETS[sym] as DesignMarket | undefined;
  if (!live) return { ...(design ?? MARKETS.TSLA), displaySymbol: `${design ? sym : "TSLA"}-USD` };

  const category = CAT_OF[live.assetClass] ?? design?.cat ?? "Crypto";
  const [kind, noun] = KIND_OF[category];
  return {
    kind: design?.kind ?? kind,
    noun: design?.noun ?? noun,
    ink: design?.ink ?? "#16130f",
    isNew: design?.isNew,
    // Arcus data doesn't cover these; the design's figures stand in where it had them.
    vol: design?.vol ?? "—",
    fund: design?.fund ?? "—",
    mcap: design?.mcap ?? "—",
    oi: design?.oi ?? "—",
    tok: design?.tok ?? "0",
    name: live.fullAssetName,
    cat: category,
    base: Number(live.markPrice) || design?.base || 0,
    lev: live.maxLeverage,
    tint: design?.tint ?? colorFromString(sym),
    logo: live.logoUrl ?? undefined,
    displaySymbol: live.displaySymbol,
    live,
  };
};

/** Sub-$10 markets (XRP) get 4 decimals, sub-cent memecoins 6; everything else 2. */
export const dpOf = (sym: string) => {
  const base = cat(sym).base;
  return base >= 10 ? 2 : base >= 0.01 ? 4 : 6;
};

export const money = (n: number, d = 2) =>
  "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export function volFmt(n: number) {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1e6) return (v / 1e6).toFixed(2) + " M";
  if (v >= 1e3) return (v / 1e3).toFixed(2) + " K";
  return String(Math.round(v));
}

export function kmoney(n: number) {
  const v = Math.abs(Number(n));
  if (v >= 1000) return "$" + (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k";
  return "$" + Math.round(v);
}

export type Side = "long" | "short";

export type Position = {
  id: number;
  sym: string;
  side: Side;
  lev: number;
  qty: number;
  entry: number;
  tokenized: boolean;
  addr: string;
  alias?: string;
  borrowed: number;
  listed: number;
  buyin: number;
};

export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1D"] as const;
export const RANGES = ["5y", "1y", "6m", "3m", "1m", "5d", "1d"] as const;
export const MARKET_TABS = ["Spot", "Perpetuals"] as const;
export const MARKET_CATS = ["All", "Crypto", "Equities", "Commodities", "Indices"] as const;
export const SIZE_CHIPS = [500, 2500, 10000, 18400];

/** Minutes per bar, used to space the chart's time axis. */
export const TF_MINUTES: Record<string, number> = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1D": 1440 };

/** Free margin is a fixed number in the prototype; MAX chip matches it. */
export const FREE_MARGIN = 18400;
export const BASE_EQUITY = 48250;

/** Below this width the market-info panel collapses regardless of `infoOpen`. */
export const INFO_MIN_WIDTH = 1180;
