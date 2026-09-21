/**
 * The prototype's `renderVals()` — every string, colour and path the position
 * screen paints, derived from the series plus the range/amount/reaction state.
 *
 * Handlers stay out of here: the prototype closed over `setState` inside the
 * value bag, but the components on this side call the engine's actions, the
 * way the community screen already does.
 */

import {
  DEPOSIT,
  ENTRY,
  HOLDERS,
  RANGE_FRACTION,
  RANGES,
  SUPPLY,
  compact,
  usd,
  type RangeKey,
  type Report,
  type Series,
  type Side,
  type Status,
} from "./data";

export type Reaction = { emoji: string; count: number; mine: boolean; who: string };

export const DEFAULT_REACTIONS: Reaction[] = [
  { emoji: "🚀", count: 48, mine: false, who: "ape.eth, sinewave and 46 others" },
  { emoji: "🧊", count: 12, mine: true, who: "you, monkshood and 10 others" },
  { emoji: "🐂", count: 9, mine: false, who: "pinebar and 8 others" },
  { emoji: "💀", count: 4, mine: false, who: "quietsize and 3 others" },
];

export type ViewState = {
  range: RangeKey;
  amount: string;
  reacts: Reaction[];
  picker: boolean;
  /** buy-ins made this session, added to the holder count */
  holders: number;
};

/** The six knobs the prototype exposed in its props panel, already defaulted. */
export type PositionConfig = {
  nickname: string;
  status: Status;
  side: Side;
  leverage: number;
  creatorFeeBps: number;
  collateralized: boolean;
};

export type Chip = { key: RangeKey; label: RangeKey; bg: string; ink: string; border: string };

export type Stat = { k: string; v: string; c: string; sub?: string };

export type Row = { k: string; v: string; c: string };

export type ReactionView = {
  emoji: string;
  count: number;
  who: string;
  bg: string;
  border: string;
  ink: string;
};

export type Holder = { name: string; tint: string; share: string };

export type QuickAmount = { label: string; value: string };

const chip = (on: boolean) => ({
  bg: on ? "#9670ff" : "rgba(255,255,255,0.05)",
  ink: on ? "#fdfbf7" : "#c2b6e4",
  border: on ? "#9670ff" : "rgba(255,255,255,0.14)",
});

export function derive(series: Series, s: ViewState, cfg: PositionConfig) {
  const { status, side, leverage: lev, creatorFeeBps: feeBps, collateralized } = cfg;
  const isClosed = status === "Closed";
  const atRisk = status === "At risk";

  const { asset, reports } = series;

  // A closed position stops reporting at 84% of the walk; everything after is
  // history the contract never saw.
  const frac = RANGE_FRACTION[s.range] ?? 0.55;
  const cut = isClosed ? Math.floor(asset.length * 0.84) : asset.length;
  const from = Math.max(0, Math.floor(cut - cut * frac));
  const aSlice = asset.slice(from, cut);
  const rSlice = reports.filter((x) => x.i >= from && x.i <= cut - 1);
  const span = Math.max(1, cut - 1 - from);

  // --- underlying: a plain polyline over its own min/max, entry pinned in ---
  const aLo = Math.min(...aSlice, ENTRY);
  const aHi = Math.max(...aSlice, ENTRY);
  const aSp = aHi - aLo || 1;
  const ay = (v: number) => 172 - ((v - aLo) / aSp) * 152;
  const assetLine =
    "M" +
    aSlice
      .map((v, i) => ((i / (aSlice.length - 1)) * 600).toFixed(1) + "," + ay(v).toFixed(1))
      .join(" L");

  // --- NAV: stepped, because the flat stretches are what the contract saw ---
  const navVals = rSlice.map((x) => x.nav);
  const nLo = Math.min(...navVals, DEPOSIT);
  const nHi = Math.max(...navVals, DEPOSIT);
  const nSp = nHi - nLo || 1;
  const ny = (v: number) => 172 - ((v - nLo) / nSp) * 152;
  const nx = (i: number) => ((i - from) / span) * 600;

  let navLine = "";
  let prevY = 0;
  rSlice.forEach((p: Report, k: number) => {
    const x = nx(p.i);
    const y = ny(p.nav);
    navLine +=
      k === 0
        ? "M" + x.toFixed(1) + "," + y.toFixed(1)
        : " L" + x.toFixed(1) + "," + prevY.toFixed(1) + " L" + x.toFixed(1) + "," + y.toFixed(1);
    prevY = y;
  });
  // an open position is still running, so the last step carries to the edge
  if (rSlice.length && !isClosed) navLine += " L600," + ny(rSlice[rSlice.length - 1].nav).toFixed(1);
  const navArea = navLine + " L600,190 L0,190 Z";

  const last = rSlice.length
    ? rSlice[rSlice.length - 1]
    : { nav: DEPOSIT, funding: 0, mark: ENTRY, i: from };
  const navPct = (last.nav / DEPOSIT - 1) * 100;
  const assetPct = (last.mark / ENTRY - 1) * 100;
  const up = navPct >= 0;
  const aUp = assetPct >= 0;
  const pnlColor = up ? "#5fe3a8" : "#ff7d92";
  const holders = 218 + s.holders;

  // --- buy-in quote ---
  const amt = parseFloat(String(s.amount).replace(/[^0-9.]/g, "")) || 0;
  const fee = (amt * feeBps) / 10000;
  const net = Math.max(0, amt - fee);
  const shareVal = (net / (last.nav + net)) * 100;
  const buyDisabled = isClosed || amt <= 0;

  const reacts = s.reacts;

  return {
    nickname: cfg.nickname,
    structuredName: "ETH " + side + " " + lev + "×",
    ticker: "pETH" + (side === "long" ? "L" : "S") + lev,
    addr: "0x7f1ca3…3c2a",
    creator: "@sinewave",
    ageLabel: "opened 34d ago",
    accent: "#8f7bff",
    logo: "/laxu/logo-eth.png",
    initial: "E",

    statusLabel: status.toUpperCase(),
    statusBg: isClosed
      ? "rgba(255,255,255,0.08)"
      : atRisk
        ? "rgba(255,183,101,0.18)"
        : "rgba(95,227,168,0.16)",
    statusInk: isClosed ? "#a79bd0" : atRisk ? "#ffb765" : "#5fe3a8",
    sideLabel: side.toUpperCase(),
    sideRotate: side === "long" ? 0 : 90,
    sideBg: side === "long" ? "rgba(95,227,168,0.16)" : "rgba(255,125,146,0.16)",
    sideInk: side === "long" ? "#5fe3a8" : "#ff7d92",
    levLabel: lev + "× LEVERAGE",
    collateralized,
    loanLabel: "LOAN #4417",

    navPrice: usd((last.nav / SUPPLY) * 1000, 3),
    navChg: (up ? "+" : "") + navPct.toFixed(2) + "%",
    navChgAbs: (up ? "+" : "−") + compact(Math.abs(last.nav - DEPOSIT)),
    pnlColor,
    lastReport: "3m 12s ago",

    stats: [
      { k: "ENTRY", v: usd(ENTRY), c: "#fdfbf7" },
      { k: "MARK", v: usd(last.mark), c: "#fdfbf7", sub: (aUp ? "+" : "") + assetPct.toFixed(2) + "% vs entry" },
      { k: "SIZE", v: "29.9 ETH", c: "#fdfbf7", sub: compact(DEPOSIT * lev) + " notional" },
      {
        k: "UNREALIZED PNL",
        v: (up ? "+" : "") + navPct.toFixed(2) + "%",
        c: pnlColor,
        sub: (up ? "+" : "−") + compact(Math.abs(last.nav - DEPOSIT)),
      },
      // the prototype drops the dollar sign here to make room for the minus
      { k: "FUNDING ACCRUED", v: "−" + usd(last.funding, 0).slice(1), c: "#ffb765", sub: "paid since mint" },
      { k: "HOLDERS", v: String(holders), c: "#fdfbf7", sub: "across " + (holders * 3 + 40) + " wallets touched" },
      { k: "BUY-IN VOLUME", v: compact(1284000), c: "#fdfbf7", sub: "lifetime, all buyers" },
      { k: "CREATOR FEE", v: (feeBps / 100).toFixed(2) + "%", c: "#d5c6ff", sub: "on every buy-in" },
    ] as Stat[],

    ranges: RANGES.map((k) => ({ key: k, label: k, ...chip(s.range === k) })) as Chip[],
    leverageLine:
      "ETH " +
      (aUp ? "+" : "") +
      assetPct.toFixed(1) +
      "%, this position " +
      (up ? "+" : "") +
      navPct.toFixed(1) +
      "%",

    assetTitle: "ETH · underlying",
    assetLast: usd(last.mark),
    assetChg: (aUp ? "+" : "") + assetPct.toFixed(2) + "%",
    assetColor: aUp ? "#5fe3a8" : "#ff7d92",
    assetLine,
    assetArea: assetLine + " L600,190 L0,190 Z",
    assetEntryY: ay(ENTRY).toFixed(1),
    assetEntryTop: ((ay(ENTRY) / 190) * 100).toFixed(1) + "%",
    assetEntryX: from === 0 ? 3 : 0.5,
    entryPrice: usd(ENTRY, 0),

    navLine,
    navArea,
    navBaseY: ny(DEPOSIT).toFixed(1),
    navBaseTop: ((ny(DEPOSIT) / 190) * 100).toFixed(1) + "%",
    navDots: rSlice.map((p) => ({ x: nx(p.i).toFixed(1), y: ny(p.nav).toFixed(1) })),
    navLast: compact(last.nav),
    navEndX: rSlice.length ? Math.min(596, nx(rSlice[rSlice.length - 1].i)).toFixed(1) : "596",
    navEndY: ny(last.nav).toFixed(1),
    navEndTop: ((ny(last.nav) / 190) * 100).toFixed(1) + "%",
    isClosed,
    reportCount: rSlice.length,
    depositLabel: compact(DEPOSIT),
    axis: ["−" + s.range.toLowerCase(), "", "", "now"],

    reactionTotal: reacts.reduce((a, x) => a + x.count, 0),
    reactions: reacts.map((x) => ({
      emoji: x.emoji,
      count: x.count,
      who: x.who,
      bg: x.mine ? "rgba(150,112,255,0.26)" : "rgba(255,255,255,0.05)",
      border: x.mine ? "rgba(150,112,255,0.6)" : "rgba(255,255,255,0.13)",
      ink: x.mine ? "#d5c6ff" : "#c2b6e4",
    })) as ReactionView[],
    pickerOpen: s.picker,

    buyinHint: isClosed
      ? "This position is closed — buy-ins are settled."
      : "Creator fee " + (feeBps / 100).toFixed(2) + "% · settles in USDG",
    balance: compact(18420),
    amount: s.amount,
    quickAmounts: [500, 2500, 10000, 18420].map((n, i) => ({
      label: i === 3 ? "MAX" : "$" + (n >= 1000 ? n / 1000 + "K" : n),
      value: n.toLocaleString("en-US"),
    })) as QuickAmount[],
    quote: [
      { k: "Creator fee (" + (feeBps / 100).toFixed(2) + "%)", v: "−" + usd(fee), c: "#ffb765" },
      { k: "Net into position", v: usd(net), c: "#fdfbf7" },
      { k: "Your share of position", v: shareVal.toFixed(2) + "%", c: "#5fe3a8" },
      // the prototype names the long ticker here whichever way the position sits
      { k: "Tokens received", v: (net / (last.nav / SUPPLY)).toFixed(1) + " pETHL" + lev, c: "#d5c6ff" },
    ] as Row[],
    buyLabel: isClosed ? "Position closed" : amt > 0 ? "Buy in for " + usd(amt, 0) : "Enter an amount",
    buyBg: buyDisabled ? "rgba(255,255,255,0.08)" : "#9670ff",
    buyInk: buyDisabled ? "#8f85bd" : "#fdfbf7",
    buyDisabled,
    buyToast: buyDisabled
      ? ""
      : "Bought in " + usd(amt, 0) + " — " + shareVal.toFixed(2) + "% of the position",

    holdersList: HOLDERS.map((h, i) => ({
      name: h[0],
      tint: h[1],
      share: (28 - i * 4.3).toFixed(1) + "%",
    })) as Holder[],
  };
}

export type PositionVals = ReturnType<typeof derive>;
