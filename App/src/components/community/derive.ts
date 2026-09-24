/**
 * The prototype's `renderVals()` — everything the community screen paints,
 * derived from the token draw plus sort/filter/page state.
 */

import {
  KINDS,
  SORTS,
  fmtNum,
  fmtUsd,
  paths,
  wave,
  type KindKey,
  type SortKey,
  type Token,
} from "./data";

/** The hero's wave field never varies, so it is drawn once. */
export const WAVES = {
  waveA: wave(0.4, 54, 214, true),
  waveB: wave(2.1, 42, 244, true),
  waveC: wave(4.3, 68, 178, true),
  waveD: wave(5.9, 36, 262, true),
  lineA: wave(0.4, 54, 214, false),
  lineC: wave(4.3, 68, 178, false),
};

export type Chip = { label: string; bg: string; ink: string; border: string };

export type Card = {
  token: Token;
  rank: number;
  sym: string;
  title: string;
  /** Underlying market's base asset — picks the live icon. */
  base: string;
  initial: string;
  accent: string;
  logo: string;
  creator: string;
  price: string;
  chg: string;
  c: string;
  fill: string;
  line: string;
  area: string;
  vol: string;
  holders: string;
  notional: string;
  sideLabel: string;
  sideBg: string;
  sideInk: string;
  headBg: string;
  cells: { k: string; v: string }[];
};

export function card(t: Token, rank: number): Card {
  const p = paths(t.series);
  const up = t.chg >= 0;
  return {
    token: t,
    rank,
    sym: "p" + t.sym + (t.long ? "L" : "S") + t.lev,
    title: t.sym + " " + (t.long ? "long" : "short") + " " + t.lev + "×",
    base: t.sym,
    initial: t.sym[0],
    accent: t.accent,
    logo: t.logo,
    creator: "created by " + t.creator,
    price: "$" + t.price.toFixed(t.price < 10 ? 3 : 2),
    chg: (up ? "+" : "") + t.chg.toFixed(2) + "%",
    c: up ? "#5fe3a8" : "#ff7d92",
    fill: up ? "rgba(95,227,168,0.16)" : "rgba(255,125,146,0.16)",
    line: p.line,
    area: p.area,
    vol: fmtUsd(t.vol),
    holders: fmtNum(t.holders),
    notional: fmtUsd(t.notional),
    sideLabel: (t.long ? "LONG" : "SHORT") + " " + t.lev + "×",
    sideBg: t.long ? "rgba(95,227,168,0.16)" : "rgba(255,125,146,0.16)",
    sideInk: t.long ? "#5fe3a8" : "#ff7d92",
    headBg: up
      ? "linear-gradient(90deg, rgba(150,112,255,0.3), rgba(255,183,101,0.16))"
      : "linear-gradient(90deg, rgba(150,112,255,0.26), rgba(255,125,146,0.16))",
    cells: [
      { k: "VOL. 24H", v: fmtUsd(t.vol) },
      { k: "HOLDERS", v: fmtNum(t.holders) },
      { k: "NOTIONAL", v: fmtUsd(t.notional) },
    ],
  };
}

const chip = (on: boolean): Omit<Chip, "label"> => ({
  bg: on ? "#9670ff" : "rgba(255,255,255,0.05)",
  ink: on ? "#fdfbf7" : "#c2b6e4",
  border: on ? "#9670ff" : "rgba(255,255,255,0.14)",
});

const CMP: Record<SortKey, (a: Token, b: Token) => number> = {
  vol: (a, b) => b.vol - a.vol,
  perf: (a, b) => b.chg - a.chg,
  holders: (a, b) => b.holders - a.holders,
  notional: (a, b) => b.notional - a.notional,
  new: (a, b) => a.age - b.age,
};

export type ViewState = { sort: SortKey; kind: KindKey; query: string; page: number };

export function derive(
  list: Token[],
  s: ViewState,
  props: { rowsPerPage: number; spotlightCount: number },
) {
  const per = Math.max(4, props.rowsPerPage);
  const spotN = Math.min(4, Math.max(2, props.spotlightCount));
  const spotlightSrc = [...list].sort((a, b) => b.chg - a.chg).slice(0, spotN);
  const spotIds = new Set(spotlightSrc.map((t) => t.sym));

  const q = s.query.trim().toLowerCase();
  const rest = list
    .filter((t) => !spotIds.has(t.sym))
    .filter((t) => s.kind === "all" || t.kind === s.kind)
    .filter((t) => !q || (t.sym + t.name + t.creator).toLowerCase().includes(q));
  rest.sort(CMP[s.sort] || CMP.vol);

  const total = rest.length;
  const pageCount = Math.max(1, Math.ceil(total / per));
  const page = Math.min(s.page, pageCount);
  const start = (page - 1) * per;
  const slice = rest.slice(start, start + per);

  const sorts = SORTS.map(([k, label]) => ({ key: k, label, ...chip(s.sort === k) }));
  const kinds = KINDS.map(([k, label]) => ({ key: k, label, ...chip(s.kind === k) }));

  // no ellipsis: past 7 pages the list keeps the ends and the current neighbours
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1)
    .filter((n) => pageCount <= 7 || n === 1 || n === pageCount || Math.abs(n - page) <= 1)
    .map((n) => ({ n, label: String(n), ...chip(n === page) }));

  const totalVol = list.reduce((a, t) => a + t.vol, 0);
  const totalHold = list.reduce((a, t) => a + t.holders, 0);

  return {
    ...WAVES,
    heroStats: [
      { k: "POSITION TOKENS", v: String(list.length * 37 + 118), c: "#fdfbf7" },
      { k: "VOLUME 24H", v: fmtUsd(totalVol), c: "#ffb765" },
      { k: "UNIQUE HOLDERS", v: fmtNum(totalHold * 6), c: "#5fe3a8" },
    ],
    ticker: [...list]
      .sort((a, b) => b.vol - a.vol)
      .slice(0, 12)
      .map((t) => ({
        sym: "p" + t.sym + (t.long ? "L" : "S") + t.lev,
        base: t.sym,
        initial: t.sym[0],
        accent: t.accent,
        logo: t.logo,
        chg: (t.chg >= 0 ? "+" : "") + t.chg.toFixed(1) + "%",
        c: t.chg >= 0 ? "#5fe3a8" : "#ff7d92",
      })),
    spotlight: spotlightSrc.map((t, i) => card(t, i + 1)),
    rows: slice.map((t, i) => card(t, start + i + 1 + spotN)),
    sorts,
    kinds,
    pages,
    page,
    pageCount,
    empty: total === 0,
    rangeLabel:
      total === 0
        ? "No results"
        : "Showing " + (start + 1) + "–" + Math.min(start + per, total) + " of " + total + " community tokens",
    prevInk: page > 1 ? "#d5c6ff" : "#544c7d",
    nextInk: page < pageCount ? "#d5c6ff" : "#544c7d",
  };
}

export type Derived = ReturnType<typeof derive>;
