"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits } from "viem";
import { MIN_GAS_MON } from "../faucet/FaucetButton";
import { getHealth, getMyPositions, type MyPosition, type SlotStats } from "@/lib/api";
import { useAsset } from "@/lib/asset";
import { useWalletBalances } from "@/lib/balances";
import { useMarketRefresh, useMarkets } from "@/lib/markets";
import { useSession } from "@/lib/session";
import { INFO_MIN_WIDTH, cat, syms, type Position, type Side } from "./data";
import { BUSY_MESSAGE, useOpenTrade } from "./openTrade";

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
  /**
   * Arcus's mark per market: the chart's live candle for the one on screen,
   * `GET /markets` for the rest. Absent until Arcus has answered, never simulated.
   */
  px: Record<string, number>;
  /** The chart's close ~24h back, per market, so the stats bar's 24h change matches the chart's. */
  pxRef: Record<string, number>;
  candles: Record<string, Candle[]>;
  tapes: Record<string, Tape[]>;
  mq: string;
  mktTab: string;
  mktCat: string;
  favs: string[];
  /** The signed-in user's minted positions, from `GET /positions/mine`. */
  positions: Position[];
  /** Whose `positions` those are, so a sign-out or account switch never shows the last user's. */
  positionsFor: string | null;
  sel: string | null;
  notice: string;
  /** Brief note under the leverage slider, e.g. after a clamp. */
  levNote: string;
};

const INITIAL: TradeState = {
  view: "trade",
  market: "TSLA",
  infoOpen: true,
  side: "long",
  otype: "market",
  lev: 3,
  size: 50,
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
  px: {},
  pxRef: {},
  candles: EMPTY_SERIES,
  tapes: EMPTY_TAPES,
  mq: "",
  mktTab: "Perpetuals",
  mktCat: "All",
  favs: ["BTC"],
  positions: [],
  positionsFor: null,
  sel: null,
  notice: "",
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
export const posEquity = (p: Position, mark: number) => p.margin + posPnl(p, mark);
/** Liquidation sits 92% of the maintenance band away from the mark. */
export const liqOf = (mark: number, side: Side, lev: number) =>
  mark * (side === "long" ? 1 - 0.92 / lev : 1 + 0.92 / lev);

/** A backend row as the dock / tokens view draw it. Rows that never minted are dropped. */
function toPosition(row: MyPosition): Position | null {
  if (!row.positionTokenAddress || !row.symbol) return null;
  return {
    id: row.id,
    sym: row.symbol,
    side: row.direction,
    lev: row.leverage,
    qty: row.size ? Number(formatUnits(BigInt(row.size), 6)) : 0,
    entry: row.entryPrice ? Number(formatUnits(BigInt(row.entryPrice), 18)) : 0,
    margin: Number(formatUnits(BigInt(row.depositedAmount ?? row.requestedAmount), 6)),
    addr: row.positionTokenAddress,
    pool: row.lendingPoolAddress,
    nickname: row.nickname,
    listed: row.listed,
    status: row.status,
    liquidated: row.liquidated,
  };
}

const POSITIONS_POLL_MS = 30_000;
/** How often `GET /markets` refreshes the marks of markets the chart isn't streaming. */
const MARKS_POLL_MS = 5_000;
/**
 * A chart-streamed mark this recent beats the polled one: the two Arcus
 * endpoints can disagree at the same instant, and the price shouldn't flick
 * between them.
 */
const STREAM_FRESH_MS = 15_000;
const HEALTH_POLL_MS = 15_000;
/** Smallest ticket the UI offers; the backend's own minimum (Perpl's posting amount) is enforced when the slot is reserved. */
export const MIN_TRADE_AMOUNT = 1;

/** An asset amount as the decimal string the backend wants ("50", "12.5"), never exponent notation. */
export const amountString = (n: number) => n.toFixed(6).replace(/\.?0+$/, "");

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

export function useTradeEngine(liveTicks = true) {
  const [st, setSt] = useState<TradeState>(INITIAL);
  const hostEl = useRef<HTMLDivElement | null>(null);
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

  // Live markets from `GET /markets`, refetched every few seconds for their marks.
  const markets = useMarkets();
  useMarketRefresh(MARKS_POLL_MS);
  // Symbols whose series were generated from a live Arcus mark (rather than
  // the design's placeholder base) — each is seeded once.
  const liveSeeded = useRef(new Set<string>());
  // When the chart last streamed each market's mark.
  const streamedAt = useRef<Record<string, number>>({});

  // Each refresh takes Arcus's mark for every market the chart isn't streaming.
  // The decorative series (sparklines, tape) are seeded on the client, since
  // `genCandles` is random and would break hydration during render. A market
  // with no live data gets no mark at all rather than the design's sample one.
  useEffect(() => {
    setSt((s) => {
      const candles = { ...s.candles };
      const tapes = { ...s.tapes };
      const px = { ...s.px };
      let changed = !s.seeded;
      const now = Date.now();
      syms().forEach((sym) => {
        const live = cat(sym).live;
        const mark = live ? Number(live.markPrice) : 0;
        const streaming = now - (streamedAt.current[sym] ?? 0) < STREAM_FRESH_MS;
        if (mark > 0 && !streaming && px[sym] !== mark) {
          px[sym] = mark;
          changed = true;
        }
        if (candles[sym] && (!live || liveSeeded.current.has(sym))) return;
        if (live) liveSeeded.current.add(sym);
        const b = px[sym] ?? cat(sym).base;
        candles[sym] = genCandles(b);
        tapes[sym] = genTape(b);
        changed = true;
      });
      return changed ? { ...s, candles, tapes, px, now, seeded: true } : s;
    });
  }, [markets]);

  /** The chart's live Arcus candle for `sym`: its close is the mark, `ref` the close ~24h back. */
  const setLiveMark = useCallback((sym: string, mark: number, ref: number) => {
    if (!(mark > 0)) return;
    streamedAt.current[sym] = Date.now();
    setSt((s) =>
      s.px[sym] === mark && s.pxRef[sym] === ref
        ? s
        : { ...s, px: { ...s.px, [sym]: mark }, pxRef: { ...s.pxRef, [sym]: ref } },
    );
  }, []);

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

  // 1.3s tick: carries the real mark into the decorative series (the sparkline's
  // live bar, a fresh one every 7th tick, and the tape). It never moves the mark.
  useEffect(() => {
    if (!liveTicks || !st.seeded) return;
    const id = setInterval(() => {
      setSt((s) => {
        const px = s.px;
        const candles = { ...s.candles };
        const tapes = { ...s.tapes };
        Object.keys(px).forEach((m) => {
          if (px[m] == null) return;
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
        return { ...s, candles, tapes, tick: s.tick + 1, now: Date.now() };
      });
    }, 1300);
    return () => clearInterval(id);
  }, [liveTicks, st.seeded]);

  useEffect(
    () => () => {
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

  const { authenticated, wallet, user, login } = useSession();
  const owner = user?.walletAddress ?? null;
  const balances = useWalletBalances(owner);
  const { symbol } = useAsset();

  // The user's real positions; dropped on sign-out or account switch.
  const loadPositions = useCallback(() => {
    if (!owner) return;
    getMyPositions()
      .then(({ positions }) => {
        const rows = positions.map(toPosition).filter((p): p is Position => p !== null && p.status !== "settled");
        setSt((s) => ({
          ...s,
          positions: rows,
          positionsFor: owner,
          sel: rows.some((p) => p.id === s.sel) ? s.sel : (rows[0]?.id ?? null),
        }));
      })
      .catch((error) => console.error("GET /positions/mine failed", error));
  }, [owner]);

  useEffect(() => {
    if (!owner) return;
    loadPositions();
    const id = setInterval(loadPositions, POSITIONS_POLL_MS);
    return () => clearInterval(id);
  }, [owner, loadPositions]);

  // Slot pool: `free > 0` gates the ticket before anyone pays.
  const [slots, setSlots] = useState<SlotStats | null>(null);
  const loadSlots = useCallback(() => {
    getHealth()
      .then((health) => setSlots(health.slots))
      .catch(() => setSlots(null));
  }, []);
  useEffect(() => {
    loadSlots();
    const id = setInterval(loadSlots, HEALTH_POLL_MS);
    return () => clearInterval(id);
  }, [loadSlots]);

  const refreshBalances = balances.refresh;
  const onOpenSettled = useCallback(() => {
    refreshBalances();
    loadPositions();
    loadSlots();
  }, [refreshBalances, loadPositions, loadSlots]);
  const open = useOpenTrade(onOpenSettled);

  /** Leverage is clamped to the active market's cap. */
  const lev = Math.min(st.lev, cat(st.market).lev);

  /**
   * Why the ticket can't submit right now, or null. `nudge`: the fix is test
   * funds, so the ticket shows the faucet nudge alongside.
   */
  const blocker = useMemo((): { reason: string; nudge?: boolean; signIn?: boolean } | null => {
    if (!authenticated) return { reason: "Sign in to trade", signIn: true };
    if (!wallet || !owner) return { reason: "Loading your wallet\u2026" };
    if (!(st.size >= MIN_TRADE_AMOUNT)) return { reason: `Minimum trade is ${MIN_TRADE_AMOUNT} ${symbol}` };
    if (balances.asset === null || balances.mon === null) return { reason: "Checking your balances\u2026" };
    if (balances.asset < st.size) return { reason: `Not enough ${symbol} for this trade`, nudge: true };
    if (balances.mon <= MIN_GAS_MON) return { reason: "Not enough MON for gas", nudge: true };
    if (slots && slots.free <= 0) return { reason: BUSY_MESSAGE };
    if (triggerProblem(st.side, st.sl, st.tp, st.px[st.market])) return { reason: "Fix the stop loss / take profit" };
    if (open.phase.kind !== "idle" && open.phase.kind !== "error") return { reason: "Opening your position\u2026" };
    return null;
  }, [authenticated, wallet, owner, st.size, st.side, st.sl, st.tp, st.px, st.market, balances.asset, balances.mon, symbol, slots, open.phase.kind]);

  const startOpen = open.start;
  const placeOrder = useCallback(() => {
    if (blocker?.signIn) {
      login();
      return;
    }
    if (blocker) return;
    void startOpen({
      market: cat(st.market).live?.displaySymbol ?? st.market,
      direction: st.side,
      leverage: lev,
      amount: amountString(st.size),
      stopLoss: st.sl || undefined,
      takeProfit: st.tp || undefined,
    });
  }, [blocker, login, startOpen, st.market, st.side, st.size, st.sl, st.tp, lev]);

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

  // Positions loaded for another wallet (or none signed in) are hidden, not cleared.
  const view = useMemo<TradeState>(
    () => (st.positionsFor === owner ? st : { ...st, positions: [], sel: null }),
    [st, owner],
  );
  const selected = useMemo(() => view.positions.find((p) => p.id === view.sel) ?? null, [view.positions, view.sel]);
  const infoShown = st.infoOpen && st.w >= INFO_MIN_WIDTH;

  return {
    st: view,
    set,
    setSt,
    mounted: st.seeded,
    hostRef,
    lev,
    selected,
    infoShown,
    balances,
    slots,
    blocker,
    open,
    actions: { placeOrder, toggleFav, pickMarket, flash, reloadPositions: loadPositions, setLiveMark },
  };
}

export type TradeEngine = ReturnType<typeof useTradeEngine>;
