"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CandlestickData, UTCTimestamp } from "lightweight-charts";
import { env } from "./env";

/**
 * Perpl's public market data: candles, the L2 book, recent trades and the
 * per-market state (mark, 24h volume, open interest).
 *
 * Perpl serves REST with CORS headers for its own origin only and refuses the
 * market-data WebSocket handshake for any other browser Origin, so every read
 * goes through `env.marketDataBase` (the Laxu backend's cached proxy, same
 * paths as Perpl's REST) and "live" means polling:
 *
 *   market state  every 5s   (one call covers every market)
 *   book          every 2s   (only while a screen shows it)
 *   trades        every 2s   (only while a screen shows it; the backend relays
 *                             them from its own socket, Perpl has no REST for them)
 *   candle tail   every 4s   (the in-progress bar)
 *
 * One shared scheduler runs all of it: a topic is polled once however many
 * components watch it, starts 500ms after its first subscriber (so flicking
 * through markets fetches nothing), stops when the last one leaves, and
 * pauses while the tab is hidden. All prices and sizes arrive as integers
 * scaled by the market's `priceDecimals` / `sizeDecimals`.
 */

// --- wire shapes -------------------------------------------------------------

type RawState = {
  at?: { t?: number };
  /** oracle reference price */
  orl?: number;
  /** mark */
  mrk?: number;
  /** last trade */
  lst?: number;
  /** previous (24h reference) price */
  prv?: number;
  /** 24h volume, base size units */
  dv?: number;
  /** 24h volume in the collateral asset's base units (string: it overflows a double) */
  dva?: string;
  /** open interest, base size units */
  oi?: number;
};

export type PerplContextMarket = {
  id: number;
  perpetual_id: number;
  symbol: string;
  name: string;
  icon: string;
  funding_interval_sec: number;
  config: {
    is_open: boolean;
    price_decimals: number;
    size_decimals: number;
    initial_margin: number;
    maintenance_margin: number;
    taker_fee: number;
  };
  state?: RawState;
  funding?: { at?: { t?: number }; rate?: number };
};

export type PerplContext = {
  instances: Array<{ min_account_open_amount: string }>;
  tokens: Array<{ symbol: string; decimals: number }>;
  markets: PerplContextMarket[];
};

/** The slice of a market the scaling helpers need. */
export type Scale = { priceDecimals: number; sizeDecimals: number };

// --- plain fetches -----------------------------------------------------------

export class MarketDataError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MarketDataError";
  }
}

async function getJson<T>(path: string, signal?: AbortSignal, base = env.marketDataBase): Promise<T> {
  const res = await fetch(`${base}/v1/${path}`, { signal });
  if (!res.ok) throw new MarketDataError(`Perpl market data ${res.status} for ${path}`, res.status);
  return (await res.json()) as T;
}

/** Perpl's market list: ids, decimals, limits, funding. `base` overrides the proxy (the markets fallback reads Perpl directly). */
export const fetchContext = (signal?: AbortSignal, base?: string) => getJson<PerplContext>("pub/context", signal, base);

const scalePrice = (n: number | undefined, scale: Scale) => (n === undefined ? NaN : n / 10 ** scale.priceDecimals);
const scaleSize = (n: number | undefined, scale: Scale) => (n === undefined ? NaN : n / 10 ** scale.sizeDecimals);

// --- candles -----------------------------------------------------------------

/** Every timeframe this app offers, in Perpl's supported resolutions (seconds). */
export const TF_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "8h": 28800, "12h": 43200, "1d": 86400 } as const;
export type Timeframe = keyof typeof TF_SECONDS;

/** The position page's toggle. */
export const TIMEFRAMES = ["5m", "1h", "4h", "1d"] as const satisfies readonly Timeframe[];

/** Perpl returns at most this many candles per request. */
const MAX_CANDLES = 1024;

export type Bar = CandlestickData<UTCTimestamp> & {
  /** In the collateral asset (USD). */
  volume: number;
};

type RawCandle = { t: number; o: number; c: number; h: number; l: number; v: string; n: number };

function toBar(c: RawCandle, scale: Scale, assetDecimals: number): Bar {
  return {
    time: Math.floor(c.t / 1000) as UTCTimestamp,
    open: scalePrice(c.o, scale),
    high: scalePrice(c.h, scale),
    low: scalePrice(c.l, scale),
    close: scalePrice(c.c, scale),
    volume: Number(c.v) / 10 ** assetDecimals,
  };
}

/** Default by position age: under a day 5m, under a week 1h, otherwise 4h. */
export function defaultTimeframe(openedAtSec: number | null | undefined): Timeframe {
  if (!openedAtSec) return "1h";
  const age = Date.now() / 1000 - openedAtSec;
  if (age < 86_400) return "5m";
  if (age < 7 * 86_400) return "1h";
  return "4h";
}

/** Candles between two instants, oldest first, one bar per open time (the chart needs strictly ascending times). */
async function candlesBetween(
  marketId: number,
  resSec: number,
  fromMs: number,
  toMs: number,
  scale: Scale,
  assetDecimals: number,
  signal?: AbortSignal,
): Promise<Bar[]> {
  const body = await getJson<{ d?: RawCandle[] }>(`market-data/${marketId}/candles/${resSec}/${Math.floor(fromMs)}-${Math.floor(toMs)}`, signal);
  const bars = (body.d ?? []).map((c) => toBar(c, scale, assetDecimals)).sort((a, b) => a.time - b.time);
  return bars.filter((b, i) => i === 0 || b.time !== bars[i - 1].time);
}

/** The latest `count` candles (at most 1024) at `timeframe`. */
export function fetchCandles(
  market: { venueMarketId: number } & Scale,
  timeframe: Timeframe,
  assetDecimals: number,
  count = MAX_CANDLES,
  signal?: AbortSignal,
): Promise<Bar[]> {
  const res = TF_SECONDS[timeframe];
  const now = Date.now();
  return candlesBetween(market.venueMarketId, res, now - Math.min(count, MAX_CANDLES) * res * 1000, now, market, assetDecimals, signal);
}

// --- the shared poller -------------------------------------------------------

type Topic<T> = {
  key: string;
  ms: number;
  /** Wait this long after the first subscriber before the first fetch. */
  delayMs: number;
  fetch: () => Promise<T>;
  listeners: Set<(value: T) => void>;
  errorListeners: Set<(error: unknown) => void>;
  last: T | undefined;
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: boolean;
};

/** Registered topics by key; a topic exists only while someone watches it. */
const topics = new Map<string, Topic<unknown>>();

/** Switching markets fetches nothing until the new one has been on screen this long. */
const ACTIVATE_DELAY_MS = 500;
const MAX_BACKOFF_MS = 30_000;

function schedule<T>(topic: Topic<T>, wait: number) {
  if (topic.timer) clearTimeout(topic.timer);
  topic.timer = setTimeout(() => void tick(topic), wait);
}

async function tick<T>(topic: Topic<T>) {
  topic.timer = null;
  if (topics.get(topic.key) !== (topic as Topic<unknown>)) return;
  // A hidden tab polls nothing; the visibility handler wakes it.
  if (typeof document !== "undefined" && document.hidden) return;
  if (topic.inflight) return;
  topic.inflight = true;
  try {
    const value = await topic.fetch();
    if (topics.get(topic.key) !== (topic as Topic<unknown>)) return;
    topic.failures = 0;
    topic.last = value;
    topic.listeners.forEach((fn) => fn(value));
  } catch (error) {
    topic.failures += 1;
    topic.errorListeners.forEach((fn) => fn(error));
  } finally {
    topic.inflight = false;
  }
  if (topics.get(topic.key) === (topic as Topic<unknown>)) {
    schedule(topic, Math.min(MAX_BACKOFF_MS, topic.ms * 2 ** Math.min(topic.failures, 4)));
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    for (const topic of topics.values()) if (!topic.timer && !topic.inflight) schedule(topic, 0);
  });
}

/**
 * Watch `key`, polled every `ms`. Shares one fetch loop between every watcher
 * and replays the last value to a newcomer at once. Returns the unsubscribe.
 */
function watch<T>(
  key: string,
  ms: number,
  fetcher: () => Promise<T>,
  onValue: (value: T) => void,
  onError?: (error: unknown) => void,
  delayMs = ACTIVATE_DELAY_MS,
): () => void {
  let topic = topics.get(key) as Topic<T> | undefined;
  if (!topic) {
    topic = {
      key,
      ms,
      delayMs,
      fetch: fetcher,
      listeners: new Set(),
      errorListeners: new Set(),
      last: undefined,
      failures: 0,
      timer: null,
      inflight: false,
    };
    topics.set(key, topic as Topic<unknown>);
    schedule(topic, delayMs);
  }
  topic.listeners.add(onValue);
  if (onError) topic.errorListeners.add(onError);
  if (topic.last !== undefined) onValue(topic.last);

  const owned = topic;
  return () => {
    owned.listeners.delete(onValue);
    if (onError) owned.errorListeners.delete(onError);
    if (owned.listeners.size === 0) {
      if (owned.timer) clearTimeout(owned.timer);
      topics.delete(key);
    }
  };
}

// --- market state ------------------------------------------------------------

export type MarketState = {
  /** Perpl's mark price. */
  mark: number;
  oracle: number;
  last: number;
  /** The 24h reference price (`prv`), for the 24h change. */
  prevClose: number;
  /** 24h volume in the collateral asset (USD), or NaN when absent. */
  volumeUsd: number;
  /** Open interest in USD at the mark, or NaN when absent. */
  openInterestUsd: number;
  updatedAt: number | null;
};

type RawStates = Record<string, RawState>;

let rawStates: RawStates = {};
let statesError = false;
const stateListeners = new Set<() => void>();

const emitStates = () => stateListeners.forEach((fn) => fn());

/** Mark, volume and open interest for every market: `market-data/ticker`, one call. */
function watchStates(): () => void {
  return watch(
    "state",
    5_000,
    async () => (await getJson<{ d?: RawStates }>("market-data/ticker")).d ?? {},
    (value) => {
      rawStates = value;
      statesError = false;
      emitStates();
    },
    () => {
      if (!statesError) {
        statesError = true;
        emitStates();
      }
    },
    0,
  );
}

function subscribeStates(fn: () => void) {
  stateListeners.add(fn);
  const stop = watchStates();
  return () => {
    stateListeners.delete(fn);
    stop();
  };
}

/** The raw per-market states, keyed by Perpl market id; empty until the first poll lands. */
export function useRawMarketStates(): RawStates {
  return useSyncExternalStore(
    subscribeStates,
    () => rawStates,
    () => rawStates,
  );
}

/** True once a poll has failed and no state has arrived since. */
export function useMarketStateError(): boolean {
  return useSyncExternalStore(
    subscribeStates,
    () => statesError,
    () => false,
  );
}

/** `state` scaled for `market`, in human units and USD. Null until Perpl has answered for it. */
export function scaleState(raw: RawState | undefined, market: Scale, assetDecimals: number): MarketState | null {
  if (!raw || !raw.mrk) return null;
  const mark = scalePrice(raw.mrk, market);
  return {
    mark,
    oracle: scalePrice(raw.orl, market),
    last: scalePrice(raw.lst, market),
    prevClose: scalePrice(raw.prv, market),
    volumeUsd: raw.dva !== undefined ? Number(raw.dva) / 10 ** assetDecimals : NaN,
    openInterestUsd: raw.oi !== undefined ? scaleSize(raw.oi, market) * mark : NaN,
    updatedAt: raw.at?.t ?? null,
  };
}

// --- book and trades ---------------------------------------------------------

export type BookLevel = { price: number; size: number };
export type Book = { bids: BookLevel[]; asks: BookLevel[] };

type RawBook = { bid?: Array<{ p: number; s: number }>; ask?: Array<{ p: number; s: number }> };

/** The L2 book while `enabled` (the screen shows it). Bids best-first, asks best-first. */
export function useBook(market: ({ venueMarketId: number } & Scale) | undefined, enabled = true): { book: Book | null; error: boolean } {
  const [state, setState] = useState<{ key: string; book: Book | null; error: boolean }>({ key: "", book: null, error: false });
  const id = market?.venueMarketId;
  const price = market?.priceDecimals;
  const size = market?.sizeDecimals;
  const key = `${id}`;
  useEffect(() => {
    if (!enabled || id === undefined || price === undefined || size === undefined) return;
    const scale = { priceDecimals: price, sizeDecimals: size };
    return watch(
      `book:${id}`,
      2_000,
      () => getJson<RawBook>(`market-data/${id}/book`),
      (raw) =>
        setState({
          key,
          error: false,
          book: {
            bids: (raw.bid ?? []).map((l) => ({ price: scalePrice(l.p, scale), size: scaleSize(l.s, scale) })),
            asks: (raw.ask ?? []).map((l) => ({ price: scalePrice(l.p, scale), size: scaleSize(l.s, scale) })),
          },
        }),
      () => setState((s) => ({ ...s, key, error: true })),
    );
  }, [enabled, id, price, size, key]);
  // a book read for the market just switched away from never shows
  return state.key === key ? { book: state.book, error: state.error } : { book: null, error: false };
}

export type Trade = { key: string; time: number; price: number; size: number; buy: boolean };

type RawTrade = { t: number; p: number; s: number; sd: number; txid: string };

/** Recent trades while `enabled`, newest first (`sd` 1 = buy, 2 = sell). */
export function useTrades(market: ({ venueMarketId: number } & Scale) | undefined, enabled = true): { trades: Trade[] | null; error: boolean } {
  const [state, setState] = useState<{ key: string; trades: Trade[] | null; error: boolean }>({ key: "", trades: null, error: false });
  const id = market?.venueMarketId;
  const price = market?.priceDecimals;
  const size = market?.sizeDecimals;
  const key = `${id}`;
  useEffect(() => {
    if (!enabled || id === undefined || price === undefined || size === undefined) return;
    const scale = { priceDecimals: price, sizeDecimals: size };
    return watch(
      `trades:${id}`,
      2_000,
      () => getJson<{ d?: RawTrade[] }>(`market-data/${id}/trades`),
      (raw) =>
        setState({
          key,
          error: false,
          trades: (raw.d ?? []).map((t, i) => ({
            key: `${t.txid}:${t.t}:${i}`,
            time: t.t,
            price: scalePrice(t.p, scale),
            size: scaleSize(t.s, scale),
            buy: t.sd === 1,
          })),
        }),
      () => setState((s) => ({ ...s, key, error: true })),
    );
  }, [enabled, id, price, size, key]);
  return state.key === key ? { trades: state.trades, error: state.error } : { trades: null, error: false };
}

// --- live candle -------------------------------------------------------------

/**
 * The in-progress bar, live: every 4s the last few candles are re-read and
 * handed over oldest first, which is exactly `series.update()` per bar (an
 * update carries the previous candle too, so a bar that closed between polls
 * still lands). Returns the unsubscribe.
 */
export function watchLiveCandles(
  market: { venueMarketId: number } & Scale,
  timeframe: Timeframe,
  assetDecimals: number,
  onBars: (bars: Bar[]) => void,
  onError?: (error: unknown) => void,
): () => void {
  const res = TF_SECONDS[timeframe];
  return watch(
    `candles:${market.venueMarketId}:${res}`,
    4_000,
    () => {
      const now = Date.now();
      return candlesBetween(market.venueMarketId, res, now - res * 3 * 1000, now, market, assetDecimals);
    },
    onBars,
    onError,
  );
}

/** A ref that always holds the latest value, for effects that must not re-run when a callback changes. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
