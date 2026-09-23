import type { CandlestickData, UTCTimestamp } from "lightweight-charts";
import { env } from "./env";

/**
 * Arcus public market data: candle history over REST, the live bar over
 * WebSocket. No auth, and Arcus answers REST with `access-control-allow-origin: *`,
 * so the browser calls it directly — no backend passthrough.
 */

/** Every timeframe Arcus serves. */
export type ArcusTimeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "8h" | "12h" | "1d" | "3d" | "1w";

/** The position page's toggle. */
export const TIMEFRAMES = ["5m", "1h", "4h", "1d"] as const satisfies readonly ArcusTimeframe[];
export type Timeframe = (typeof TIMEFRAMES)[number];

export type ArcusCandle = {
  /** MICROseconds since epoch. */
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  isFinal: boolean;
};

/** Arcus stamps bars in microseconds; Lightweight Charts wants seconds. */
export const toBar = (c: ArcusCandle): CandlestickData<UTCTimestamp> => ({
  time: Math.floor(c.openTime / 1_000_000) as UTCTimestamp,
  open: Number(c.open),
  high: Number(c.high),
  low: Number(c.low),
  close: Number(c.close),
});

/** Default by position age: under a day 5m, under a week 1h, otherwise 4h. */
export function defaultTimeframe(openedAtSec: number | null | undefined): Timeframe {
  if (!openedAtSec) return "1h";
  const age = Date.now() / 1000 - openedAtSec;
  if (age < 86_400) return "5m";
  if (age < 7 * 86_400) return "1h";
  return "4h";
}

/**
 * Candle history, oldest first, one bar per open time. The live endpoint
 * returns newest-first; the chart needs strictly ascending unique times, so
 * this sorts rather than trusting the order.
 */
export async function fetchRawCandles(
  market: string,
  timeframe: ArcusTimeframe,
  countback = 500,
  signal?: AbortSignal,
): Promise<ArcusCandle[]> {
  const params = new URLSearchParams({
    market,
    timeframe,
    // `to` is in microseconds too.
    to: String(Date.now() * 1000),
    countback: String(Math.min(countback, 1500)),
  });
  const res = await fetch(`${env.arcusApiUrl}/v1/candles?${params}`, { signal });
  if (!res.ok) throw new Error(`Arcus candles ${res.status}`);
  const body = (await res.json()) as { candles: ArcusCandle[] };
  const sorted = [...body.candles].sort((a, b) => a.openTime - b.openTime);
  return sorted.filter((c, i) => i === 0 || c.openTime !== sorted[i - 1].openTime);
}

export async function fetchCandles(
  market: string,
  timeframe: ArcusTimeframe,
  countback = 500,
  signal?: AbortSignal,
): Promise<CandlestickData<UTCTimestamp>[]> {
  return (await fetchRawCandles(market, timeframe, countback, signal)).map(toBar);
}

/**
 * The in-progress bar, live. Subscribes with `snapshot: false` so the stream
 * doesn't repeat what REST already returned; each frame either replaces the
 * in-progress bar or opens the next one, which is exactly `series.update()`.
 * Reconnects with backoff. Returns an unsubscribe.
 */
export function subscribeCandles(
  market: string,
  timeframe: ArcusTimeframe,
  onBar: (bar: CandlestickData<UTCTimestamp>) => void,
): () => void {
  return subscribeRawCandles(market, timeframe, (candle) => onBar(toBar(candle)));
}

/** As {subscribeCandles}, with the whole Arcus candle (volume included). */
export function subscribeRawCandles(
  market: string,
  timeframe: ArcusTimeframe,
  onCandle: (candle: ArcusCandle) => void,
): () => void {
  const id = `${market}/${timeframe}`;
  let socket: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    socket = new WebSocket(env.arcusWsUrl);
    socket.onopen = () => {
      retry = 0;
      socket?.send(JSON.stringify({ type: "subscribe", channel: "candles", id, snapshot: false }));
    };
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as { type?: string; id?: string; contents?: ArcusCandle };
        if (frame.type === "channel_data" && frame.id === id && frame.contents?.openTime) {
          onCandle(frame.contents);
        }
      } catch {
        // a malformed frame is dropped, never fatal to the stream
      }
    };
    socket.onclose = () => {
      if (closed) return;
      timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
    };
  };

  connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    socket?.close();
  };
}
