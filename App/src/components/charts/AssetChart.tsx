"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts";
import { useAsset } from "@/lib/asset";
import type { LaxuMarket } from "@/lib/markets";
import { defaultTimeframe, fetchCandles, TIMEFRAMES, watchLiveCandles, type Bar, type Timeframe } from "@/lib/perplMarketData";
import { MONO } from "../position/shared";
import { applyWindow, baseChartOptions, entryLine, FROST } from "./theme";

export type AssetChartProps = {
  /** The market to draw; undefined until the live list has loaded. */
  market: LaxuMarket | undefined;
  side: "long" | "short";
  /** Unset, the entry bar's open stands in (demo mode knows only a time). */
  entryPrice?: number | null;
  /** unix seconds; also picks the default timeframe */
  entryTime?: number | null;
  /** trailing seconds to show; null shows everything loaded */
  windowSec?: number | null;
  height?: number;
  /** last close and the entry it is measured against, for the card header */
  onLast?: (close: number, entry: number) => void;
};

/**
 * The underlying, as candles, straight from Perpl: history first, then the
 * in-progress bar re-read every few seconds. Entry is a dashed amber price
 * line plus an arrow at the entry bar (up under it for a long, down over it
 * for a short).
 */
export default function AssetChart({
  market,
  side,
  entryPrice,
  entryTime,
  windowSec,
  height = 190,
  onLast,
}: AssetChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>(() => defaultTimeframe(entryTime));
  const [error, setError] = useState<string | null>(null);
  const { decimals: assetDecimals } = useAsset();
  const onLastRef = useRef(onLast);
  const windowRef = useRef(windowSec);
  useEffect(() => {
    onLastRef.current = onLast;
    windowRef.current = windowSec;
  });

  // one chart per mount; series data swaps underneath it
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, baseChartOptions);
    series.current = c.addSeries(CandlestickSeries, {
      upColor: FROST.green,
      downColor: FROST.rose,
      borderUpColor: FROST.green,
      borderDownColor: FROST.rose,
      wickUpColor: FROST.green,
      wickDownColor: FROST.rose,
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  const marketId = market?.venueMarketId;
  const priceDecimals = market?.priceDecimals;
  const sizeDecimals = market?.sizeDecimals;

  useEffect(() => {
    const s = series.current;
    if (!s || marketId === undefined || priceDecimals === undefined || sizeDecimals === undefined) return;
    const scale = { venueMarketId: marketId, priceDecimals, sizeDecimals };
    const abort = new AbortController();
    let unsubscribe: (() => void) | null = null;
    let bars: Bar[] = [];
    const lines: ReturnType<typeof s.createPriceLine>[] = [];
    let markers: { detach(): void } | null = null;
    setError(null);
    s.applyOptions({ priceFormat: { type: "price", precision: priceDecimals, minMove: 10 ** -priceDecimals } });

    fetchCandles(scale, timeframe, assetDecimals, 500, abort.signal)
      .then((history) => {
        if (abort.signal.aborted) return;
        bars = history;
        s.setData(history);

        // snap to the bar that contains the entry, so the arrow lands on a candle
        const at = entryTime ? [...history].reverse().find((bar) => bar.time <= entryTime) : undefined;
        const entry = entryPrice ?? at?.open ?? history[0]?.open;
        if (entry) lines.push(s.createPriceLine({ ...entryLine, price: entry }));
        if (at) {
          markers = createSeriesMarkers(s, [
            side === "long"
              ? { time: at.time, position: "belowBar", shape: "arrowUp", color: FROST.amber, text: "Entry" }
              : { time: at.time, position: "aboveBar", shape: "arrowDown", color: FROST.amber, text: "Entry" },
          ]);
        }
        if (chart.current) applyWindow(chart.current, windowRef.current);
        if (history.length && entry) onLastRef.current?.(history[history.length - 1].close, entry);

        // history first, then the live tail: each poll hands over the last few bars, oldest first
        unsubscribe = watchLiveCandles(scale, timeframe, assetDecimals, (fresh) => {
          for (const bar of fresh) {
            const last = bars[bars.length - 1];
            if (last && bar.time < last.time) continue; // stale frame; update() would throw
            s.update(bar);
            if (!last || bar.time > last.time) bars = [...bars, bar];
            else bars[bars.length - 1] = bar;
          }
          const close = bars[bars.length - 1]?.close;
          if (entry && close !== undefined) onLastRef.current?.(close, entry);
        });
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(e instanceof Error ? "Perpl candles are unavailable right now" : "Could not load candles");
      });

    return () => {
      abort.abort();
      unsubscribe?.();
      markers?.detach();
      for (const line of lines) s.removePriceLine(line);
    };
  }, [marketId, priceDecimals, sizeDecimals, timeframe, side, entryPrice, entryTime, assetDecimals]);

  useEffect(() => {
    if (chart.current) applyWindow(chart.current, windowSec);
  }, [windowSec]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ position: "relative", height }}>
        <div ref={el} style={{ position: "absolute", inset: 0 }} />
        {error && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 12, color: FROST.muted }}>
            {error}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 5 }}>
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf}
            type="button"
            onClick={() => setTimeframe(tf)}
            aria-pressed={tf === timeframe}
            style={{
              fontFamily: MONO,
              fontSize: 10.5,
              fontWeight: 600,
              padding: "4px 10px",
              borderRadius: 99,
              cursor: "pointer",
              border: `1px solid ${tf === timeframe ? FROST.violet : "rgba(255,255,255,0.14)"}`,
              background: tf === timeframe ? "rgba(150,112,255,0.22)" : "transparent",
              color: tf === timeframe ? FROST.ink : FROST.muted,
            }}
          >
            {tf}
          </button>
        ))}
      </div>
    </div>
  );
}
