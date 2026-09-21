/**
 * The price walk, the `onReport` replay and the formatters, transcribed from
 * `Laxu Position.dc.html`.
 *
 * The prototype built all of this in `componentDidMount`, so its first frame
 * was the empty early-return of `renderVals()`. The draw is deterministic and
 * depends on nothing but the leverage prop, so here it is rebuilt during
 * render instead: the server and the client land on the same numbers and the
 * page is whole on first paint.
 */

export type Status = "Open" | "At risk" | "Closed";
export type Side = "long" | "short";
export type RangeKey = "24H" | "7D" | "30D" | "ALL";

export const RANGES: RangeKey[] = ["24H", "7D", "30D", "ALL"];

/** How much of the history each range window keeps. */
export const RANGE_FRACTION: Record<RangeKey, number> = {
  "24H": 0.06,
  "7D": 0.22,
  "30D": 0.55,
  ALL: 1,
};

export const PALETTE = ["🚀", "🧊", "🔥", "🫡", "💀", "🧠", "🌊", "⚡", "🐂", "🐻"];

export const HOLDERS: [handle: string, tint: string][] = [
  ["@sinewave", "#9670ff"],
  ["@monkshood", "#ffb765"],
  ["@0xharu", "#5fe3a8"],
  ["@pinebar", "#ff7d92"],
  ["@quietsize", "#8f7bff"],
  ["@basis.trader", "#e8c15a"],
];

/** Entry price of the underlying, the creator's deposit, and the token supply. */
export const ENTRY = 4182.5;
export const DEPOSIT = 25000;
export const SUPPLY = 25000;

/** One `onReport` triple as the contract saw it: mark, accrued funding, NAV. */
export type Report = { i: number; mark: number; funding: number; nav: number };

export type Series = { asset: number[]; reports: Report[] };

/** The prototype's linear congruential generator. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 180 ticks of ETH, then the reports the oracle actually posted against them —
 * irregular gaps, because deviation and heartbeat are what trigger a report.
 * Both loops draw from one stream, so they stay in the prototype's order.
 */
export function buildSeries(lev: number): Series {
  const r = rng(41);

  const asset: number[] = [];
  let v = ENTRY;
  for (let i = 0; i < 180; i++) {
    v = Math.max(ENTRY * 0.6, v * (1 + (r() - 0.474) * 0.012));
    asset.push(v);
  }

  const nav = (mark: number, funding: number) => DEPOSIT * (1 + lev * (mark / ENTRY - 1)) - funding;

  const reports: Report[] = [];
  let i = 0;
  let funding = 0;
  while (i < asset.length) {
    funding += 4 + r() * 22;
    reports.push({ i, mark: asset[i], funding, nav: nav(asset[i], funding) });
    i += 2 + Math.floor(r() * 11);
  }
  const end = asset.length - 1;
  reports.push({ i: end, mark: asset[end], funding, nav: nav(asset[end], funding) });

  return { asset, reports };
}

export const usd = (n: number, d?: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: d ?? 2, maximumFractionDigits: d ?? 2 });

export const compact = (n: number) =>
  n >= 1000000
    ? "$" + (n / 1000000).toFixed(2) + "M"
    : n >= 1000
      ? "$" + (n / 1000).toFixed(1) + "K"
      : "$" + n.toFixed(0);
