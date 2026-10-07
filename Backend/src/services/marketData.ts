import axios from "axios";
import WebSocket from "ws";

import { config } from "../config/env";
import { HttpError, badRequest, notFound } from "../lib/errors";
import { createLogger } from "../lib/logger";
import { perplApiUrl } from "../venue/perpl/config";

/**
 * Perpl's public market data for the browser.
 *
 * Perpl answers REST with `access-control-allow-origin` only for its own
 * origin and refuses the market-data WebSocket handshake (403) for any other
 * browser Origin (checked 2026-10-07 from http://localhost:3000), so the App
 * cannot call either directly. This file is the allowlisted, cached passthrough
 * the App uses instead (`NEXT_PUBLIC_MARKET_DATA_BASE`), and a server-side
 * trades relay: Perpl has no REST endpoint for trades, so the tape is the one
 * stream the backend holds open on the browser's behalf.
 *
 * Nothing here is authenticated, moves money or touches the database.
 */

const log = createLogger("market-data");

// ---------------------------------------------------------------------------
// REST passthrough
// ---------------------------------------------------------------------------

const TTL_CONTEXT_MS = 60_000;
const TTL_BOOK_MS = 2_000;
const TTL_TICKER_MS = 2_000;
/// A range ending at (or near) now -- the chart's live bar -- is re-read this often.
const TTL_CANDLE_TAIL_MS = 3_000;
/// History is the same for everyone: one read per 30 s serves every viewer.
const TTL_CANDLE_HISTORY_MS = 30_000;
const BUCKET_MS = 30_000;
/// A range this short (in candles) is a tail poll, not a history load.
const TAIL_CANDLES = 6;

const RESOLUTIONS = new Set([60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400]);
const MAX_CACHE_ENTRIES = 400;

interface Route {
  /// Matches the path after `/v1/`.
  pattern: RegExp;
  ttl: (match: RegExpExecArray) => number;
  /// Rewrites the path (after `/v1/`) so near-identical requests share a cache entry.
  normalise?: (match: RegExpExecArray) => string;
}

const ROUTES: Route[] = [
  { pattern: /^pub\/context$/, ttl: () => TTL_CONTEXT_MS },
  { pattern: /^market-data\/ticker$/, ttl: () => TTL_TICKER_MS },
  { pattern: /^market-data\/(\d{1,6})\/ticker$/, ttl: () => TTL_TICKER_MS },
  { pattern: /^market-data\/(\d{1,6})\/book$/, ttl: () => TTL_BOOK_MS },
  {
    pattern: /^market-data\/(\d{1,6})\/candles\/(\d{2,5})\/(\d{10,14})-(\d{10,14})$/,
    ttl: (m) => {
      const [res, from, to] = [Number(m[2]), Number(m[3]), Number(m[4])];
      return (to - from) / 1000 <= res * TAIL_CANDLES ? TTL_CANDLE_TAIL_MS : TTL_CANDLE_HISTORY_MS;
    },
    // `to` is "now" in the browser, different every call: bucket it, or the cache never hits.
    normalise: (m) => {
      const from = Math.floor(Number(m[3]) / BUCKET_MS) * BUCKET_MS;
      const to = Math.ceil(Number(m[4]) / BUCKET_MS) * BUCKET_MS;
      return `market-data/${m[1]}/candles/${m[2]}/${from}-${to}`;
    },
  },
];

interface Entry {
  at: number;
  status: number;
  body: unknown;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();

export interface Passthrough {
  status: number;
  body: unknown;
  /// Seconds the browser may reuse it.
  maxAge: number;
}

/**
 * `path` is everything after `/v1/` in Perpl's REST API. Anything not on the
 * allowlist is a 404 -- this is not an open proxy.
 */
export async function proxyPublic(path: string): Promise<Passthrough> {
  let route: Route | undefined;
  let match: RegExpExecArray | null = null;
  for (const candidate of ROUTES) {
    match = candidate.pattern.exec(path);
    if (match) {
      route = candidate;
      break;
    }
  }
  if (!route || !match) throw notFound(`No such market-data path: ${path}`, "UNKNOWN_MARKET_DATA_PATH");

  const candles = /^market-data\/\d+\/candles\/(\d+)\//.exec(path);
  if (candles && !RESOLUTIONS.has(Number(candles[1]))) {
    throw badRequest(`Unsupported candle resolution ${candles[1]}`, "INVALID_RESOLUTION");
  }

  const target = route.normalise ? route.normalise(match) : path;
  const ttl = route.ttl(match);
  const hit = cache.get(target);
  if (hit && Date.now() - hit.at < ttl) return answer(hit, ttl);

  let pending = inflight.get(target);
  if (!pending) {
    pending = fetchUpstream(target).finally(() => inflight.delete(target));
    inflight.set(target, pending);
  }
  try {
    const entry = await pending;
    if (entry.status === 200) store(target, entry);
    return answer(entry, entry.status === 200 ? ttl : 0);
  } catch (error) {
    // Perpl unreachable: a stale answer beats an empty screen.
    if (hit) return answer(hit, 0);
    log.warn("upstream failed", { target, error: error instanceof Error ? error.message : String(error) });
    throw new HttpError(502, "Perpl market data is unreachable", "MARKET_DATA_UNAVAILABLE");
  }
}

async function fetchUpstream(target: string): Promise<Entry> {
  const res = await axios.get(`${perplApiUrl()}/v1/${target}`, {
    timeout: config.perplRequestTimeoutMs,
    validateStatus: (status) => status < 500,
    // Candle series for a long window run to a few hundred KB of JSON.
    maxContentLength: 8 * 1024 * 1024,
  });
  return { at: Date.now(), status: res.status, body: res.data };
}

function store(key: string, entry: Entry): void {
  cache.set(key, entry);
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  // Maps iterate in insertion order: drop the oldest.
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

function answer(entry: Entry, ttl: number): Passthrough {
  return { status: entry.status, body: entry.body, maxAge: Math.floor(ttl / 1000) };
}

// ---------------------------------------------------------------------------
// Trades relay
// ---------------------------------------------------------------------------

/// What the browser gets for one trade. Prices and sizes are Perpl's integers:
/// the App scales them with the market's priceDecimals / sizeDecimals.
export interface RelayedTrade {
  /// ms since epoch
  t: number;
  p: number;
  s: number;
  /// 1 = buy, 2 = sell
  sd: number;
  txid: string;
}

const MAX_TRADES = 60;
/// Perpl allows 16 subscriptions and 10 sub requests per minute per connection.
const MAX_SUBSCRIPTIONS = 12;
const MAX_REQUESTS_PER_MIN = 8;
const FLUSH_DEBOUNCE_MS = 400;
/// A market nobody has asked about for this long is unsubscribed.
const IDLE_MS = 90_000;
const SNAPSHOT_WAIT_MS = 2_500;

const MT_SUBSCRIBE = 5;
const MT_SUBSCRIPTION_RESPONSE = 6;
const MT_TRADES_SNAPSHOT = 17;
const MT_TRADES_UPDATE = 18;

interface TradeBook {
  trades: RelayedTrade[];
  /// Subscribed upstream (as far as we know).
  subscribed: boolean;
  /// A snapshot has arrived at least once.
  ready: boolean;
  lastAsked: number;
  waiters: Array<() => void>;
}

class TradesRelay {
  private ws: WebSocket | null = null;
  private open = false;
  private readonly books = new Map<number, TradeBook>();
  /// Streams the socket should currently be subscribed to.
  private readonly wanted = new Set<number>();
  private readonly subscribedOnSocket = new Set<number>();
  private readonly requestTimes: number[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private retry = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  async tradesFor(marketId: number): Promise<RelayedTrade[]> {
    const book = this.book(marketId);
    book.lastAsked = Date.now();
    this.ensureRunning();
    if (!this.wanted.has(marketId)) this.want(marketId);
    if (!book.ready) await new Promise<void>((resolve) => this.wait(book, resolve));
    return book.trades.slice(0, 50);
  }

  private wait(book: TradeBook, resolve: () => void): void {
    const timer = setTimeout(() => {
      book.waiters = book.waiters.filter((w) => w !== done);
      resolve();
    }, SNAPSHOT_WAIT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    book.waiters.push(done);
  }

  private book(marketId: number): TradeBook {
    let book = this.books.get(marketId);
    if (!book) {
      book = { trades: [], subscribed: false, ready: false, lastAsked: 0, waiters: [] };
      this.books.set(marketId, book);
    }
    return book;
  }

  private want(marketId: number): void {
    // Over the cap: drop the least recently asked-about market.
    if (this.wanted.size >= MAX_SUBSCRIPTIONS) {
      let victim: number | null = null;
      let oldest = Infinity;
      for (const id of this.wanted) {
        const asked = this.books.get(id)?.lastAsked ?? 0;
        if (asked < oldest) {
          oldest = asked;
          victim = id;
        }
      }
      if (victim !== null) this.drop(victim);
    }
    this.wanted.add(marketId);
    this.scheduleFlush();
  }

  private drop(marketId: number): void {
    this.wanted.delete(marketId);
    const book = this.books.get(marketId);
    if (book) {
      book.ready = false;
      book.subscribed = false;
      book.trades = [];
    }
    this.scheduleFlush();
  }

  private ensureRunning(): void {
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), 15_000);
      this.sweepTimer.unref();
    }
    if (!this.ws && !this.reconnectTimer) this.connect();
  }

  private sweep(): void {
    const now = Date.now();
    for (const id of [...this.wanted]) {
      if (now - (this.books.get(id)?.lastAsked ?? 0) > IDLE_MS) this.drop(id);
    }
    // Nothing wanted for a while: close the socket rather than idle on it.
    if (this.wanted.size === 0 && this.subscribedOnSocket.size === 0 && this.ws) {
      this.ws.close(1000, "idle");
    }
  }

  private connect(): void {
    const url = `${config.perplWsUrl.replace(/\/$/, "")}/ws/v1/market-data`;
    const ws = new WebSocket(url, config.perplOrigin ? { headers: { Origin: config.perplOrigin } } : undefined);
    this.ws = ws;
    ws.on("open", () => {
      this.open = true;
      this.retry = 0;
      this.subscribedOnSocket.clear();
      this.flush();
    });
    ws.on("message", (raw) => this.onMessage(String(raw)));
    ws.on("error", (error) => log.warn("market-data socket error", { error: error.message }));
    ws.on("close", (code) => {
      this.open = false;
      this.ws = null;
      this.subscribedOnSocket.clear();
      for (const book of this.books.values()) {
        book.subscribed = false;
        book.ready = false;
      }
      this.wakeAll();
      if (this.wanted.size === 0) return;
      const delay = Math.min(30_000, 1_000 * 2 ** this.retry++);
      log.warn("market-data socket closed", { code, retryInMs: delay });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
      this.reconnectTimer.unref();
    });
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref();
  }

  /// One frame carries every change; at most MAX_REQUESTS_PER_MIN of them a minute.
  private flush(): void {
    if (!this.ws || !this.open) return;
    const subs: Array<{ stream: string; subscribe: boolean }> = [];
    for (const id of this.wanted) {
      if (!this.subscribedOnSocket.has(id)) subs.push({ stream: `trades@${id}`, subscribe: true });
    }
    for (const id of this.subscribedOnSocket) {
      if (!this.wanted.has(id)) subs.push({ stream: `trades@${id}`, subscribe: false });
    }
    if (subs.length === 0) return;

    const now = Date.now();
    while (this.requestTimes.length && now - this.requestTimes[0] > 60_000) this.requestTimes.shift();
    if (this.requestTimes.length >= MAX_REQUESTS_PER_MIN) {
      const wait = 60_000 - (now - this.requestTimes[0]) + 100;
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, wait);
      this.flushTimer.unref();
      return;
    }
    this.requestTimes.push(now);
    this.ws.send(JSON.stringify({ mt: MT_SUBSCRIBE, subs }));
    for (const sub of subs) {
      const id = Number(sub.stream.split("@")[1]);
      if (sub.subscribe) this.subscribedOnSocket.add(id);
      else this.subscribedOnSocket.delete(id);
    }
  }

  private onMessage(raw: string): void {
    let frame: { mt?: number; sid?: number; d?: unknown; subs?: Array<{ stream: string; status: { code: number } }> };
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame.mt === MT_SUBSCRIPTION_RESPONSE) {
      for (const sub of frame.subs ?? []) {
        const id = Number(sub.stream.split("@")[1]);
        if (sub.status.code === 0) {
          const book = this.books.get(id);
          if (book) book.subscribed = true;
        } else {
          log.warn("subscription refused", { stream: sub.stream, code: sub.status.code });
          this.subscribedOnSocket.delete(id);
          // 429: back to the caller as "no data yet" rather than hammering.
          const book = this.books.get(id);
          if (book) {
            book.ready = true;
            this.release(book);
          }
        }
      }
      return;
    }
    if (frame.mt !== MT_TRADES_SNAPSHOT && frame.mt !== MT_TRADES_UPDATE) return;
    // sid = 2_000_000 + market id for trades streams.
    const marketId = typeof frame.sid === "number" ? frame.sid - 2_000_000 : NaN;
    const book = this.books.get(marketId);
    if (!book || !Array.isArray(frame.d)) return;
    const incoming = (frame.d as Array<{ at: { t: number; txid?: string }; p: number; s: number; sd: number }>).map(
      (trade): RelayedTrade => ({ t: trade.at.t, p: trade.p, s: trade.s, sd: trade.sd, txid: trade.at.txid ?? "" }),
    );
    // Newest first; a snapshot replaces, an update prepends.
    incoming.sort((a, b) => b.t - a.t);
    book.trades =
      frame.mt === MT_TRADES_SNAPSHOT ? incoming.slice(0, MAX_TRADES) : [...incoming, ...book.trades].slice(0, MAX_TRADES);
    book.ready = true;
    this.release(book);
  }

  private release(book: TradeBook): void {
    const waiters = book.waiters;
    book.waiters = [];
    waiters.forEach((resolve) => resolve());
  }

  private wakeAll(): void {
    for (const book of this.books.values()) this.release(book);
  }
}

const relay = new TradesRelay();

export function recentTrades(marketId: number): Promise<RelayedTrade[]> {
  return relay.tradesFor(marketId);
}
