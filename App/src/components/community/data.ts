/**
 * Seed catalogue, pseudo-random draw and formatters, transcribed from
 * `Laxu Community.dc.html`. The prototype built this list in
 * `componentDidMount`; the draw is deterministic, so it runs at module scope
 * here and the server and the client render the same first frame.
 */

export type Kind = "crypto" | "stock" | "index" | "commodity";

type Seed = [sym: string, name: string, kind: Kind, accent: string, logo: string];

const SEED_LIST: Seed[] = [
  ["ETH", "Ethereum", "crypto", "#8f7bff", "/laxu/logo-eth.png"],
  ["BTC", "Bitcoin", "crypto", "#f7931a", ""],
  ["SOL", "Solana", "crypto", "#14f195", ""],
  ["TSLA", "Tesla", "stock", "#e82127", "/laxu/logo-tsla.png"],
  ["NVDA", "Nvidia", "stock", "#76b900", ""],
  ["XRP", "XRP", "crypto", "#9fb4c7", ""],
  ["QQQ", "Nasdaq 100", "index", "#5b8def", ""],
  ["GOLD", "Gold", "commodity", "#e8c15a", ""],
  ["SPX", "S&P 500", "index", "#c2b6e4", ""],
  ["CRCL", "Circle", "stock", "#3ea8ff", ""],
  ["USO", "Crude oil", "commodity", "#8a8375", ""],
  ["AAPL", "Apple", "stock", "#d7d7d7", ""],
  ["MSFT", "Microsoft", "stock", "#6fb3e0", ""],
  ["AMZN", "Amazon", "stock", "#ff9900", ""],
  ["META", "Meta", "stock", "#4a8cff", ""],
  ["AVAX", "Avalanche", "crypto", "#e84142", ""],
  ["LINK", "Chainlink", "crypto", "#2a5ada", ""],
  ["DOGE", "Dogecoin", "crypto", "#c3a634", ""],
  ["ARB", "Arbitrum", "crypto", "#28a0f0", ""],
  ["OP", "Optimism", "crypto", "#ff0420", ""],
  ["COIN", "Coinbase", "stock", "#0052ff", ""],
  ["HOOD", "Robinhood", "stock", "#ccff00", ""],
  ["PLTR", "Palantir", "stock", "#b0b7bd", ""],
  ["AMD", "AMD", "stock", "#ed1c24", ""],
  ["MSTR", "Strategy", "stock", "#f6871f", ""],
  ["SUI", "Sui", "crypto", "#6fbcf0", ""],
  ["TON", "Toncoin", "crypto", "#3f9ad6", ""],
  ["ADA", "Cardano", "crypto", "#0d64d2", ""],
  ["GME", "GameStop", "stock", "#e4002b", ""],
  ["UNI", "Uniswap", "crypto", "#ff007a", ""],
  ["LTC", "Litecoin", "crypto", "#b8b8b8", ""],
  ["NFLX", "Netflix", "stock", "#e50914", ""],
  ["SILV", "Silver", "commodity", "#c9cdd4", ""],
  ["DJI", "Dow 30", "index", "#a79bd0", ""],
];

const HANDLES = [
  "@vaultpilot", "@sinewave", "@0xharu", "@delta.eth", "@monkshood",
  "@crabmarket", "@tenorclub", "@pinebar", "@loop.hood", "@gammagirl",
  "@basis.trader", "@orangepill", "@nightdesk", "@quietsize", "@refractor",
  "@parabola", "@slowbleed", "@vegakid", "@ironcondor", "@pxl.eth",
];

/** The prototype's linear congruential generator — one stream per market. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export const fmtUsd = (n: number) =>
  n >= 1000000
    ? "$" + (n / 1000000).toFixed(n >= 10000000 ? 1 : 2) + "M"
    : n >= 1000
      ? "$" + (n / 1000).toFixed(1) + "K"
      : "$" + n.toFixed(2);

export const fmtNum = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(Math.round(n)));

export type Token = {
  sym: string;
  name: string;
  kind: Kind;
  accent: string;
  logo: string;
  long: boolean;
  lev: number;
  price: number;
  series: number[];
  chg: number;
  vol: number;
  holders: number;
  notional: number;
  /** Drawn but never shown on this screen; kept so the rng sequence matches. */
  entry: number;
  creator: string;
  age: number;
  /** A minted token behind the row: its sparkline reads the real NAV history. */
  positionTokenAddress?: string;
};

export function buildTokens(): Token[] {
  return SEED_LIST.map((m, i) => {
    const r = rng(i * 7919 + 13);
    const long = r() > 0.34;
    const lev = [2, 3, 5, 8, 10, 15, 20][Math.floor(r() * 7)];
    const base = 0.6 + r() * 4.2;
    const series: number[] = [];
    let v = base;
    for (let k = 0; k < 44; k++) {
      v = Math.max(0.08, v * (1 + (r() - 0.47) * 0.055));
      series.push(v);
    }
    const chg = (series[43] / series[30] - 1) * 100 * (0.8 + r() * 0.7);
    return {
      sym: m[0], name: m[1], kind: m[2], accent: m[3], logo: m[4], long, lev,
      price: series[43], series, chg,
      vol: 8000 + Math.pow(r(), 2.1) * 9400000,
      holders: 12 + Math.floor(Math.pow(r(), 1.9) * 4200),
      notional: 40000 + Math.pow(r(), 1.6) * 21000000,
      entry: series[0] * (40 + r() * 900),
      creator: HANDLES[i % HANDLES.length],
      age: 1 + Math.floor(r() * 70),
    };
  });
}

/** Sparkline geometry in the card's 300×76 viewBox. */
export function paths(series: number[]) {
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  const sp = hi - lo || 1;
  const pts = series.map((v, i) => [(i / (series.length - 1)) * 300, 68 - ((v - lo) / sp) * 58]);
  const line = "M" + pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" L");
  return { line, area: line + " L300,76 L0,76 Z" };
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
  ["perf", "24h performance"],
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
