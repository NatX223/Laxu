"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  createChart,
  HistogramSeries,
  PriceScaleMode,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { fetchRawCandles, subscribeRawCandles, toBar, type ArcusCandle, type ArcusTimeframe } from "@/lib/arcus";
import { applyWindow, baseChartOptions } from "./theme";

/** The trade screen's own candle colours, from the design. */
const UP = "#4caf50";
const DOWN = "#e8543a";
const UP_VOL = "rgba(76,175,80,0.45)";
const DOWN_VOL = "rgba(232,84,58,0.45)";

/** Arcus caps a single history request at 1500 bars. */
const COUNTBACK = 1500;

export type ScaleMode = "normal" | "log" | "percent";

export type LiveBar = { o: number; h: number; l: number; c: number; v: number; ref: number };

export type TradeChartProps = {
  /** Arcus market name, e.g. "TSLA-USD". */
  market: string;
  timeframe: ArcusTimeframe;
  /** trailing seconds to show; null shows everything loaded */
  windowSec: number | null;
  scaleMode: ScaleMode;
  autoScale: boolean;
  /** Last bar and the close ~24h before it, for the header readout. */
  onBar?: (bar: LiveBar) => void;
};

const volumeOf = (c: ArcusCandle): HistogramData<UTCTimestamp> => ({
  time: Math.floor(c.openTime / 1_000_000) as UTCTimestamp,
  value: Number(c.volume) || 0,
  color: Number(c.close) >= Number(c.open) ? UP_VOL : DOWN_VOL,
});

const MODE: Record<ScaleMode, PriceScaleMode> = {
  normal: PriceScaleMode.Normal,
  log: PriceScaleMode.Logarithmic,
  percent: PriceScaleMode.Percentage,
};

/**
 * The trade screen's main chart: Arcus candles with a volume pane underneath,
 * history over REST then the in-progress bar over WebSocket. TradingView's
 * attribution logo stays on — the Lightweight Charts licence requires it.
 */
export default function TradeChart({ market, timeframe, windowSec, scaleMode, autoScale, onBar }: TradeChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** first loaded bar, unix seconds -- bounds the range pills */
  const earliest = useRef<number | undefined>(undefined);
  const onBarRef = useRef(onBar);
  const windowRef = useRef(windowSec);
  useEffect(() => {
    onBarRef.current = onBar;
    windowRef.current = windowSec;
  });

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      ...baseChartOptions,
      rightPriceScale: { borderColor: "rgba(255,255,255,0.06)", scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: "rgba(255,255,255,0.06)", timeVisible: true, secondsVisible: false },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.045)" },
        horzLines: { color: "rgba(255,255,255,0.045)" },
      },
    });
    candles.current = c.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    // volume on its own overlay scale, pinned to the bottom fifth
    volume.current = c.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    c.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      candles.current = null;
      volume.current = null;
    };
  }, []);

  useEffect(() => {
    const cs = candles.current;
    const vs = volume.current;
    if (!cs || !vs) return;
    const abort = new AbortController();
    let unsubscribe: (() => void) | null = null;
    let history: ArcusCandle[] = [];
    setError(null);

    const report = () => {
      const last = history[history.length - 1];
      if (!last) return;
      // reference: the close ~24h before the last bar, else the first loaded
      const dayAgo = last.openTime - 86_400 * 1_000_000;
      const ref = [...history].reverse().find((c) => c.openTime <= dayAgo) ?? history[0];
      onBarRef.current?.({
        o: Number(last.open),
        h: Number(last.high),
        l: Number(last.low),
        c: Number(last.close),
        v: Number(last.volume) || 0,
        ref: Number(ref.close),
      });
    };

    fetchRawCandles(market, timeframe, COUNTBACK, abort.signal)
      .then((raw) => {
        if (abort.signal.aborted) return;
        history = raw;
        cs.setData(raw.map(toBar));
        vs.setData(raw.map(volumeOf));
        earliest.current = raw.length ? Math.floor(raw[0].openTime / 1_000_000) : undefined;
        if (chart.current) applyWindow(chart.current, windowRef.current, earliest.current);
        report();

        unsubscribe = subscribeRawCandles(market, timeframe, (candle) => {
          const last = history[history.length - 1];
          if (last && candle.openTime < last.openTime) return; // stale; update() would throw
          cs.update(toBar(candle));
          vs.update(volumeOf(candle));
          if (last && candle.openTime === last.openTime) history[history.length - 1] = candle;
          else history = [...history, candle];
          report();
        });
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Could not load candles");
      });

    return () => {
      abort.abort();
      unsubscribe?.();
    };
  }, [market, timeframe]);

  useEffect(() => {
    if (chart.current) applyWindow(chart.current, windowSec, earliest.current);
  }, [windowSec]);

  useEffect(() => {
    chart.current?.priceScale("right").applyOptions({ mode: MODE[scaleMode], autoScale });
  }, [scaleMode, autoScale]);

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 450 }}>
      <div ref={el} style={{ position: "absolute", inset: 0 }} />
      {error && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            fontSize: 12,
            color: "#8e86a3",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
