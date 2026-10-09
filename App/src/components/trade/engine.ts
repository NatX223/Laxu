"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits } from "viem";
import { MIN_GAS_MON } from "../faucet/FaucetButton";
import { getHealth, getMyPositions, type MyPosition, type SlotStats } from "@/lib/api";
import { useAsset } from "@/lib/asset";
import { useWalletBalances } from "@/lib/balances";
import { defaultMarketSymbol, marketFor, useMarketRefresh, useMarkets, useMarketsError, type LaxuMarket } from "@/lib/markets";
import { useRawMarketStates } from "@/lib/perplMarketData";
import { useSession } from "@/lib/session";
import { INFO_MIN_WIDTH, cat, type Position, type Side } from "./data";
import { BUSY_MESSAGE, useOpenTrade } from "./openTrade";
import { markFor } from "./stats";

export type View = "trade" | "tokens" | "portfolio";

/**
 * The trade screen's UI state: which market, the ticket's inputs, the open
 * panels, and the signed-in user's positions. Everything about a market itself
 * (mark, book, tape, candles, stats) is Perpl's, read where it is shown; none
 * of it lives here and none of it is simulated.
 */
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
  w: number;
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
  // replaced by the default live market (ETH when listed) once the list loads
  market: "ETH",
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
  // the prototype read clientWidth here; 1400 is its fallback and keeps the
  // first client render identical to the server's
  w: 1400,
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

/**
 * Liquidation sits 92% of the maintenance band away from the mark. Perpl
 * margins a position at its stated leverage, so it reads as roughly
 * entry ∓ 1/leverage.
 */
export const liqOf = (mark: number, side: Side, lev: number) =>
  mark * (side === "long" ? 1 - 0.92 / lev : 1 + 0.92 / lev);

/** A backend row as the dock / tokens view draw it. Rows that never minted are dropped. */
function toPosition(row: MyPosition, assetDecimals: number): Position | null {
  if (!row.positionTokenAddress || !row.symbol) return null;
  return {
    id: row.id,
    sym: row.symbol,
    side: row.direction,
    lev: row.leverage,
    // `size` is the base asset at 6 dp whatever the market's own lot size
    qty: row.size ? Number(formatUnits(BigInt(row.size), 6)) : 0,
    entry: row.entryPrice ? Number(formatUnits(BigInt(row.entryPrice), 18)) : 0,
    margin: Number(formatUnits(BigInt(row.depositedAmount ?? row.requestedAmount), assetDecimals)),
    addr: row.positionTokenAddress,
    pool: row.lendingPoolAddress,
    nickname: row.nickname,
    listed: row.listed,
    status: row.status,
    liquidated: row.liquidated,
  };
}

const POSITIONS_POLL_MS = 30_000;
/** The market list (ids, decimals, limits, funding) barely moves; marks are live separately. */
const MARKETS_POLL_MS = 60_000;
const HEALTH_POLL_MS = 15_000;
/** Smallest ticket the UI offers; the backend's own minimum is enforced when the slot is reserved. */
export const MIN_TRADE_AMOUNT = 1;

/** An asset amount as the decimal string the backend wants ("50", "12.5"), never exponent notation. */
export const amountString = (n: number) => n.toFixed(6).replace(/\.?0+$/, "");

/** The smallest ticket, and why (empty when it is just the UI's own floor). */
export type MinTrade = { amount: number; note: string };

/**
 * The smallest ticket Perpl will take: at least its minimum deposit (every open
 * deposits the whole amount; the backend refuses less from the same Perpl
 * field), and at least one lot, `10^-sizeDecimals` of the base asset, at this
 * leverage, with a 5% buffer for the mark moving before the order lands.
 */
export function minTradeFor(market: LaxuMarket, lev: number, mark: number | null): MinTrade {
  const deposit = market.minDeposit > 0 ? market.minDeposit : 0;
  const lot = mark === null || !(lev > 0) ? 0 : Math.ceil(((mark / 10 ** market.sizeDecimals / lev) * 1.05) * 100) / 100;
  if (lot > deposit && lot > MIN_TRADE_AMOUNT) return { amount: lot, note: "one lot at this leverage" };
  if (deposit > MIN_TRADE_AMOUNT) return { amount: deposit, note: "Perpl's minimum deposit" };
  return { amount: MIN_TRADE_AMOUNT, note: "" };
}

/**
 * The contract's rule for the creator's SL/TP, checked against the entry
 * estimate: a long's stop loss below and take profit above, a short's the
 * other way round. Blank means none.
 */
export function triggerProblem(side: Side, sl: string, tp: string, mark: number | undefined | null): string | null {
  const valid = (v: string) => /^\d+(\.\d+)?$/.test(v);
  if (sl && !valid(sl)) return "Stop loss must be a price";
  if (tp && !valid(tp)) return "Take profit must be a price";
  if (!mark) return null;
  const long = side === "long";
  if (sl && (long ? Number(sl) >= mark : Number(sl) <= mark)) return `Stop loss must be ${long ? "below" : "above"} the entry`;
  if (tp && (long ? Number(tp) <= mark : Number(tp) >= mark)) return `Take profit must be ${long ? "above" : "below"} the entry`;
  return null;
}

export function useTradeEngine() {
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

  // The live market list: ids, decimals, limits, funding. Marks come from Perpl's market state.
  const markets = useMarkets();
  const marketsFailed = useMarketsError();
  useMarketRefresh(MARKETS_POLL_MS);
  const rawStates = useRawMarketStates();
  const { symbol, decimals: assetDecimals } = useAsset();

  /** Perpl's mark for `sym` (the latest market state, else the backend's last synced one); null when unknown. */
  const markOf = useCallback(
    (sym: string): number | null => {
      const m = marketFor(sym);
      return m ? markFor(m, rawStates, assetDecimals) : null;
    },
    // `markets` is read through marketFor's store; listing it re-derives when the list changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawStates, assetDecimals, markets],
  );

  // A symbol Perpl doesn't list (or the list just loaded) lands on the default market, preferring ETH.
  useEffect(() => {
    if (markets.length === 0) return;
    setSt((s) => {
      if (marketFor(s.market)) return s;
      const fallback = defaultMarketSymbol();
      return fallback ? { ...s, market: fallback } : s;
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

  // The user's real positions; dropped on sign-out or account switch.
  const loadPositions = useCallback(() => {
    if (!owner) return;
    getMyPositions()
      .then(({ positions }) => {
        const rows = positions
          .map((row) => toPosition(row, assetDecimals))
          .filter((p): p is Position => p !== null && p.status !== "settled");
        setSt((s) => ({
          ...s,
          positions: rows,
          positionsFor: owner,
          sel: rows.some((p) => p.id === s.sel) ? s.sel : (rows[0]?.id ?? null),
        }));
      })
      .catch((error) => console.error("GET /positions/mine failed", error));
  }, [owner, assetDecimals]);

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

  const market = cat(st.market);
  /** The market's real leverage limit; the slider and the clamp read nothing else. */
  const levMax = market.lev;
  /** Leverage is clamped to the active market's cap. */
  const lev = Math.max(1, Math.min(st.lev, levMax || 1));
  const mark = market.live ? markOf(market.live.baseAsset) : null;
  const { amount: minTrade, note: minTradeNote } = market.live
    ? minTradeFor(market.live, lev, mark)
    : { amount: MIN_TRADE_AMOUNT, note: "" };

  /**
   * Why the ticket can't submit right now, or null. `nudge`: the fix is test
   * funds, so the ticket shows the faucet nudge alongside.
   */
  const blocker = useMemo((): { reason: string; nudge?: boolean; signIn?: boolean } | null => {
    if (!authenticated) return { reason: "Sign in to trade", signIn: true };
    if (!wallet || !owner) return { reason: "Loading your wallet…" };
    // No live market, no ticket: the screen never falls back to made-up limits.
    if (!market.live) return { reason: marketsFailed ? "Markets are unavailable right now" : "Loading markets…" };
    if (!(st.size >= minTrade)) return { reason: `Minimum trade is ${minTrade} ${symbol}${minTradeNote ? ` (${minTradeNote})` : ""}` };
    if (balances.asset === null || balances.mon === null) return { reason: "Checking your balances…" };
    if (balances.asset < st.size) return { reason: `Not enough ${symbol} for this trade`, nudge: true };
    if (balances.mon <= MIN_GAS_MON) return { reason: "Not enough MON for gas", nudge: true };
    if (slots && slots.free <= 0) return { reason: BUSY_MESSAGE };
    if (triggerProblem(st.side, st.sl, st.tp, mark)) return { reason: "Fix the stop loss / take profit" };
    if (open.phase.kind !== "idle" && open.phase.kind !== "error") return { reason: "Opening your position…" };
    return null;
  }, [authenticated, wallet, owner, market.live, marketsFailed, st.size, minTrade, minTradeNote, st.side, st.sl, st.tp, mark, balances.asset, balances.mon, symbol, slots, open.phase.kind]);

  const startOpen = open.start;
  const placeOrder = useCallback(() => {
    if (blocker?.signIn) {
      login();
      return;
    }
    if (blocker || !market.live) return;
    void startOpen({
      market: market.live.displaySymbol,
      direction: st.side,
      leverage: lev,
      amount: amountString(st.size),
      stopLoss: st.sl || undefined,
      takeProfit: st.tp || undefined,
    });
  }, [blocker, login, startOpen, market.live, st.side, st.size, st.sl, st.tp, lev]);

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
      clamped = m.lev > 0 && s.lev > m.lev;
      return {
        ...s,
        market: sym,
        mktMenu: false,
        mq: "",
        lev: m.lev > 0 ? Math.min(s.lev, m.lev) : s.lev,
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
    hostRef,
    lev,
    levMax,
    mark,
    minTrade,
    minTradeNote,
    marketsFailed,
    markOf,
    selected,
    infoShown,
    balances,
    slots,
    blocker,
    open,
    actions: { placeOrder, toggleFav, pickMarket, flash, reloadPositions: loadPositions },
  };
}

export type TradeEngine = ReturnType<typeof useTradeEngine>;
