"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMarkets } from "@/lib/markets";
import { FREE_MARGIN, INFO_MIN_WIDTH, cat, syms, type Position, type Side } from "./data";

export type Candle = { o: number; c: number; h: number; l: number; v: number };
export type Tape = { p: number; s: number; buy: boolean; t: string };

export type View = "trade" | "tokens" | "portfolio";

/** Series are seeded on mount, so the server renders an empty chart. */
const EMPTY_SERIES: Record<string, Candle[]> = {};
const EMPTY_TAPES: Record<string, Tape[]> = {};

export type TradeState = {
  view: View;
  market: string;
  infoOpen: boolean;
  side: Side;
  otype: "market" | "limit";
  lev: number;
  size: number;
  limit: string | null;
  /** Optional stop loss / take profit, human prices: the defaults for everyone who buys in. */
  sl: string;
  tp: string;
  tf: string;
  range: string;
  tab: "book" | "trades";
  mktMenu: boolean;
  tick: number;
  /** Wall clock, refreshed per tick — read instead of `Date.now()` in render. */
  now: number;
  /** False until the client has generated the price series. */
  seeded: boolean;
  w: number;
  px: Record<string, number>;
  candles: Record<string, Candle[]>;
  tapes: Record<string, Tape[]>;
  mq: string;
  mktTab: string;
  mktCat: string;
  favs: string[];
  positions: Position[];
  sel: number;
  stage: "idle" | "filling";
  notice: string;
  uid: number;
  mintFor: number | null;
  mintName: string;
  /** Brief note under the leverage slider, e.g. after a clamp. */
  levNote: string;
};

const INITIAL: TradeState = {
  view: "trade",
  market: "TSLA",
  infoOpen: true,
  side: "long",
  otype: "market",
  lev: 5,
  size: 2500,
  limit: null,
  sl: "",
  tp: "",
  tf: "15m",
  range: "1m",
  tab: "book",
  mktMenu: false,
  tick: 0,
  now: 0,
  seeded: false,
  // the prototype read clientWidth here; 1400 is its fallback and keeps the
  // first client render identical to the server's
  w: 1400,
  px: { TSLA: 431.2, ETH: 4943.8 },
  candles: EMPTY_SERIES,
  tapes: EMPTY_TAPES,
  mq: "",
  mktTab: "Perpetuals",
  mktCat: "All",
  favs: ["BTC"],
  positions: [
    { id: 1, sym: "ETH", side: "long", lev: 5, qty: 12.4, entry: 4182.5, tokenized: true, addr: "0x7f1c…3c2a", borrowed: 8200, listed: 0, buyin: 0 },
    { id: 2, sym: "TSLA", side: "short", lev: 3, qty: 58.6, entry: 447.9, tokenized: false, addr: "", borrowed: 0, listed: 0, buyin: 0 },
  ],
  sel: 1,
  stage: "idle",
  notice: "",
  uid: 2,
  mintFor: null,
  mintName: "",
  levNote: "",
};

/** 64 bars of a sine-plus-noise walk starting 3.8% below the base price. */
function genCandles(base: number): Candle[] {
  let p = base * 0.962;
  const out: Candle[] = [];
  for (let i = 0; i < 64; i++) {
    const o = p;
    p = o + (Math.sin(i / 4.5) * 0.5 + (Math.random() - 0.42)) * base * 0.0055;
    const swing = Math.abs(p - o) / (base * 0.0055);
    out.push({
      o,
      c: p,
      h: Math.max(o, p) + Math.random() * base * 0.0026,
      l: Math.min(o, p) - Math.random() * base * 0.0026,
      v: (0.35 + swing * 0.9 + Math.random() * 0.5) * (base > 1000 ? 5.2e6 : 3.1e6),
    });
  }
  return out;
}

function makeTrade(px: number, ago: number): Tape {
  const d = new Date(Date.now() - ago * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    p: px * (1 + (Math.random() - 0.5) * 0.0009),
    s: Math.round(Math.random() * 90 + 6) / (px > 1000 ? 10 : 1),
    buy: Math.random() > 0.45,
    t: pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()),
  };
}

const genTape = (base: number) => Array.from({ length: 15 }, (_, i) => makeTrade(base, i * 7 + 3));

/** Price range of a series padded by 8%, plus the value-to-percent mapper. */
export function scale(list: Candle[]) {
  let hi = -Infinity;
  let lo = Infinity;
  list.forEach((c) => {
    hi = Math.max(hi, c.h);
    lo = Math.min(lo, c.l);
  });
  const pad = (hi - lo) * 0.08 || 1;
  hi += pad;
  lo -= pad;
  return { hi, lo, y: (v: number) => ((hi - v) / (hi - lo)) * 100 };
}

export function shapeCandles(list: Candle[]) {
  const { y } = scale(list);
  return list.map((c, i) => {
    const up = c.c >= c.o;
    const top = y(Math.max(c.o, c.c));
    const bot = y(Math.min(c.o, c.c));
    return {
      key: i,
      color: up ? "#4caf50" : "#e8543a",
      wickTop: y(c.h) + "%",
      wickH: Math.max(0.4, y(c.l) - y(c.h)) + "%",
      bodyTop: top + "%",
      bodyH: Math.max(0.7, bot - top) + "%",
    };
  });
}

/** The prototype's deterministic hash — book sizes redraw every second tick. */
export const rnd = (i: number, tick: number) => {
  const v = Math.sin(i * 12.9898 + Math.floor(tick / 2) * 4.1) * 43758.5453;
  return v - Math.floor(v);
};

export const posPnl = (p: Position, mark: number) => {
  const d = (mark - p.entry) * p.qty;
  return p.side === "long" ? d : -d;
};
export const posEquity = (p: Position, mark: number) => (p.qty * p.entry) / p.lev + posPnl(p, mark);
/** Liquidation sits 92% of the maintenance band away from the mark. */
export const liqOf = (mark: number, side: Side, lev: number) =>
  mark * (side === "long" ? 1 - 0.92 / lev : 1 + 0.92 / lev);

export const defaultAlias = (p: Position) => `${p.sym} ${p.side} ${p.lev}×`;

/**
 * The contract's rule for the creator's SL/TP, checked against the entry
 * estimate: a long's stop loss below and take profit above, a short's the
 * other way round. Blank means none.
 */
export function triggerProblem(side: Side, sl: string, tp: string, mark: number | undefined): string | null {
  const valid = (v: string) => /^\d+(\.\d+)?$/.test(v);
  if (sl && !valid(sl)) return "Stop loss must be a price";
  if (tp && !valid(tp)) return "Take profit must be a price";
  if (!mark) return null;
  const long = side === "long";
  if (sl && (long ? Number(sl) >= mark : Number(sl) <= mark)) return `Stop loss must be ${long ? "below" : "above"} the entry`;
  if (tp && (long ? Number(tp) <= mark : Number(tp) >= mark)) return `Take profit must be ${long ? "above" : "below"} the entry`;
  return null;
}

export function aliasTicker(p: Position, name: string) {
  const trimmed = (name || "").trim();
  const base = trimmed ? trimmed.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) : p.sym;
  return "p" + (base || p.sym) + (p.side === "long" ? "L" : "S") + p.lev;
}

export function useTradeEngine(liveTicks = true) {
  const [st, setSt] = useState<TradeState>(INITIAL);
  const hostEl = useRef<HTMLDivElement | null>(null);
  const fillTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const levNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = useCallback(<K extends keyof TradeState>(k: K, v: TradeState[K]) => {
    setSt((s) => ({ ...s, [k]: v }));
  }, []);

  const measure = useCallback(() => {
    const w = hostEl.current?.clientWidth || document.documentElement.clientWidth || 1400;
    setSt((s) => (Math.abs(w - s.w) > 6 ? { ...s, w } : s));
  }, []);

  const hostRef = useCallback(
    (el: HTMLDivElement | null) => {
      hostEl.current = el;
      if (el) requestAnimationFrame(measure);
    },
    [measure],
  );

  // Live markets from `GET /markets`; re-renders the whole screen on refresh.
  const markets = useMarkets();
  // Symbols whose series were generated from a live Arcus mark (rather than
  // the design's placeholder base) — each is seeded once, then walks.
  const liveSeeded = useRef(new Set<string>());

  // seed every market on the client — `genCandles` is random, so running it
  // during render would break hydration. Re-runs as the live list arrives, so
  // new markets get a series and the design's placeholders are replaced by
  // real prices.
  useEffect(() => {
    setSt((s) => {
      const candles = { ...s.candles };
      const tapes = { ...s.tapes };
      const px = { ...s.px };
      let changed = !s.seeded;
      syms().forEach((sym) => {
        const live = !!cat(sym).live;
        if (candles[sym] && (!live || liveSeeded.current.has(sym))) {
          // already seeded: pull the simulated walk back to Arcus's mark
          if (live) {
            px[sym] = cat(sym).base;
            changed = true;
          }
          return;
        }
        if (live) liveSeeded.current.add(sym);
        const b = cat(sym).base;
        px[sym] = b;
        candles[sym] = genCandles(b);
        tapes[sym] = genTape(b);
        changed = true;
      });
      return changed ? { ...s, candles, tapes, px, now: Date.now(), seeded: true } : s;
    });
  }, [markets]);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  // Ctrl/Cmd+K toggles the market picker, Escape closes it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSt((s) => ({ ...s, mktMenu: !s.mktMenu }));
      }
      if (e.key === "Escape") setSt((s) => (s.mktMenu ? { ...s, mktMenu: false } : s));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 1.3s price walk: extends the live bar, rolling a fresh one every 7th tick
  useEffect(() => {
    if (!liveTicks || !st.seeded) return;
    const id = setInterval(() => {
      setSt((s) => {
        const px = { ...s.px };
        const candles = { ...s.candles };
        const tapes = { ...s.tapes };
        Object.keys(px).forEach((m) => {
          if (px[m] == null) return;
          const drift = (Math.random() - 0.48) * px[m] * 0.0016;
          px[m] = Math.max(px[m] * 0.5, px[m] + drift);
          const arr = (candles[m] || []).slice();
          if (arr.length) {
            const last = { ...arr[arr.length - 1] };
            last.c = px[m];
            last.h = Math.max(last.h, px[m]);
            last.l = Math.min(last.l, px[m]);
            last.v = (last.v || 0) + (px[m] > 1000 ? 2.4e5 : 1.5e5) * Math.random();
            arr[arr.length - 1] = last;
            if (s.tick % 7 === 6) {
              arr.shift();
              arr.push({ o: px[m], c: px[m], h: px[m], l: px[m], v: (px[m] > 1000 ? 6e5 : 4e5) * (0.4 + Math.random()) });
            }
            candles[m] = arr;
          }
          tapes[m] = [makeTrade(px[m], 0)].concat((tapes[m] || []).slice(0, 14));
        });
        return { ...s, px, candles, tapes, tick: s.tick + 1, now: Date.now() };
      });
    }, 1300);
    return () => clearInterval(id);
  }, [liveTicks, st.seeded]);

  useEffect(
    () => () => {
      if (fillTimer.current) clearTimeout(fillTimer.current);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      if (levNoteTimer.current) clearTimeout(levNoteTimer.current);
    },
    [],
  );

  const flash = useCallback((msg: string) => {
    setSt((s) => ({ ...s, notice: msg }));
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setSt((s) => ({ ...s, notice: "" })), 3200);
  }, []);

  const placeOrder = useCallback(() => {
    let started = false;
    setSt((s) => {
      if (s.stage !== "idle") return s;
      if (triggerProblem(s.side, s.sl, s.tp, s.px[s.market])) return s;
      started = true;
      return { ...s, stage: "filling" };
    });
    if (!started) return;
    if (fillTimer.current) clearTimeout(fillTimer.current);
    fillTimer.current = setTimeout(() => {
      setSt((s) => {
        const price = s.px[s.market];
        const id = s.uid + 1;
        const pos: Position = {
          id,
          sym: s.market,
          side: s.side,
          lev: Math.min(s.lev, cat(s.market).lev),
          qty: (s.size * Math.min(s.lev, cat(s.market).lev)) / price,
          entry: price,
          tokenized: false,
          addr: "",
          borrowed: 0,
          listed: 0,
          buyin: 0,
        };
        return { ...s, positions: [pos].concat(s.positions), sel: id, uid: id, stage: "idle", view: "trade" };
      });
      flash("Filled on Arcus — position open. Mint it below.");
    }, 850);
  }, [flash]);

  const mintPos = useCallback((id: number) => {
    setSt((s) => {
      const p = s.positions.find((x) => x.id === id);
      if (!p || p.tokenized) return s;
      return { ...s, mintFor: id, sel: id, mintName: "" };
    });
  }, []);

  const closeMint = useCallback(() => setSt((s) => ({ ...s, mintFor: null, mintName: "" })), []);

  const confirmMint = useCallback(() => {
    let minted: { alias: string; sym: string; side: Side; lev: number } | null = null;
    setSt((s) => {
      const p = s.positions.find((x) => x.id === s.mintFor);
      if (!p || p.tokenized) return s;
      const alias = s.mintName.trim() || defaultAlias(p);
      const hex = () => Math.floor(Math.random() * 65535).toString(16).padStart(4, "0");
      const addr = "0x" + hex() + "a3…" + hex();
      minted = { alias, sym: p.sym, side: p.side, lev: p.lev };
      return {
        ...s,
        positions: s.positions.map((x) => (x.id === p.id ? { ...x, tokenized: true, addr, alias } : x)),
        sel: p.id,
        mintFor: null,
        mintName: "",
      };
    });
    // read after the updater has run so the toast names the minted position
    queueMicrotask(() => {
      if (minted) flash(`“${minted.alias}” minted — ${minted.sym} ${minted.side}, ${minted.lev}×`);
    });
  }, [flash]);

  const toggleFav = useCallback((sym: string) => {
    setSt((s) => ({
      ...s,
      favs: s.favs.includes(sym) ? s.favs.filter((x) => x !== sym) : s.favs.concat(sym),
    }));
  }, []);

  /** Switching market clamps leverage to its limit, and says so. */
  const pickMarket = useCallback((sym: string) => {
    const m = cat(sym);
    let clamped = false;
    setSt((s) => {
      clamped = s.lev > m.lev;
      return {
        ...s,
        market: sym,
        mktMenu: false,
        mq: "",
        lev: Math.min(s.lev, m.lev),
        levNote: clamped ? `Max leverage for ${m.displaySymbol} is ${m.lev}×` : "",
      };
    });
    queueMicrotask(() => {
      if (!clamped) return;
      if (levNoteTimer.current) clearTimeout(levNoteTimer.current);
      levNoteTimer.current = setTimeout(() => setSt((s) => ({ ...s, levNote: "" })), 3200);
    });
  }, []);

  /** Leverage is clamped to the active market's cap. */
  const lev = Math.min(st.lev, cat(st.market).lev);
  const selected = useMemo(() => st.positions.find((p) => p.id === st.sel) ?? null, [st.positions, st.sel]);
  const infoShown = st.infoOpen && st.w >= INFO_MIN_WIDTH;

  return {
    st,
    set,
    setSt,
    mounted: st.seeded,
    hostRef,
    lev,
    selected,
    infoShown,
    freeMargin: FREE_MARGIN,
    actions: { placeOrder, mintPos, closeMint, confirmMint, toggleFav, pickMarket, flash },
  };
}

export type TradeEngine = ReturnType<typeof useTradeEngine>;
