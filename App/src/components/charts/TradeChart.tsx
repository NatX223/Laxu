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
import { useAsset } from "@/lib/asset";
import type { LaxuMarket } from "@/lib/markets";
import { fetchCandles, watchLiveCandles, type Bar, type Timeframe } from "@/lib/perplMarketData";
import { applyWindow, baseChartOptions } from "./theme";

/** The trade screen's own candle colours, from the design. */
const UP = "#4caf50";
const DOWN = "#e8543a";
const UP_VOL = "rgba(76,175,80,0.45)";
const DOWN_VOL = "rgba(232,84,58,0.45)";

export type ScaleMode = "normal" | "log" | "percent";

/** `market` is Perpl's id for the one the bar came from, so a late bar from the previous market can be told apart. */
export type LiveBar = { market: number; o: number; h: number; l: number; c: number; v: number; ref: number };

export type TradeChartProps = {
  /** The market to draw; undefined until the live list has loaded. */
  market: LaxuMarket | undefined;
  timeframe: Timeframe;
  /** trailing seconds to show; null shows everything loaded */
  windowSec: number | null;
  scaleMode: ScaleMode;
  autoScale: boolean;
  /** Last bar and the close ~24h before it, for the header readout. */
  onBar?: (bar: LiveBar) => void;
};

const volumeOf = (b: Bar): HistogramData<UTCTimestamp> => ({
  time: b.time,
  value: b.volume || 0,
  color: b.close >= b.open ? UP_VOL : DOWN_VOL,
});

const MODE: Record<ScaleMode, PriceScaleMode> = {
  normal: PriceScaleMode.Normal,
  log: PriceScaleMode.Logarithmic,
  percent: PriceScaleMode.Percentage,
};

/**
 * The trade screen's main chart: Perpl candles with a volume pane underneath,
 * history first, then the in-progress bar re-read every few seconds.
 * TradingView's attribution logo stays on — the Lightweight Charts licence
 * requires it.
 */
export default function TradeChart({ market, timeframe, windowSec, scaleMode, autoScale, onBar }: TradeChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { decimals: assetDecimals } = useAsset();
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

  const marketId = market?.venueMarketId;
  const priceDecimals = market?.priceDecimals;
  const sizeDecimals = market?.sizeDecimals;

  useEffect(() => {
    const cs = candles.current;
    const vs = volume.current;
    if (!cs || !vs || marketId === undefined || priceDecimals === undefined || sizeDecimals === undefined) return;
    const scale = { venueMarketId: marketId, priceDecimals, sizeDecimals };
    const abort = new AbortController();
    let unsubscribe: (() => void) | null = null;
    let history: Bar[] = [];
    setError(null);
    // a $0.026 market needs its own precision, not the default two decimals
    cs.applyOptions({ priceFormat: { type: "price", precision: priceDecimals, minMove: 10 ** -priceDecimals } });

    const report = () => {
      const last = history[history.length - 1];
      if (!last) return;
      // reference: the close ~24h before the last bar, else the first loaded
      const dayAgo = last.time - 86_400;
      const ref = [...history].reverse().find((c) => c.time <= dayAgo) ?? history[0];
      onBarRef.current?.({
        market: marketId,
        o: last.open,
        h: last.high,
        l: last.low,
        c: last.close,
        v: last.volume || 0,
        ref: ref.close,
      });
    };

    fetchCandles(scale, timeframe, assetDecimals, undefined, abort.signal)
      .then((bars) => {
        if (abort.signal.aborted) return;
        history = bars;
        cs.setData(bars);
        vs.setData(bars.map(volumeOf));
        earliest.current = bars.length ? (bars[0].time as number) : undefined;
        if (chart.current) applyWindow(chart.current, windowRef.current, earliest.current);
        report();
        if (bars.length === 0) setError("No candles for this market yet");

        unsubscribe = watchLiveCandles(scale, timeframe, assetDecimals, (fresh) => {
          for (const bar of fresh) {
            const last = history[history.length - 1];
            if (last && bar.time < last.time) continue; // stale; update() would throw
            cs.update(bar);
            vs.update(volumeOf(bar));
            if (last && bar.time === last.time) history[history.length - 1] = bar;
            else history = [...history, bar];
          }
          report();
        });
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(e instanceof Error ? "Perpl candles are unavailable right now" : "Could not load candles");
      });

    return () => {
      abort.abort();
      unsubscribe?.();
    };
  }, [marketId, priceDecimals, sizeDecimals, timeframe, assetDecimals]);

  useEffect(() => {
    if (chart.current) applyWindow(chart.current, windowSec, earliest.current);
  }, [windowSec]);

  useEffect(() => {
    chart.current?.priceScale("right").applyOptions({ mode: MODE[scaleMode], autoScale });
  }, [scaleMode, autoScale]);

  return (
    <div className="laxu-chart-canvas" style={{ position: "relative", flex: 1, minHeight: 450 }}>
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
