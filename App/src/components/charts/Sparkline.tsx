"use client";

import { useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  createChart,
  CrosshairMode,
  LineSeries,
  LineType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { getNavHistory } from "@/lib/api";
import { toLineData } from "./NavChart";

/** Server-side downsampled to about this many evenly spaced points. */
const SPARK_POINTS = 50;

export type SparklineProps = {
  /** Live: the token's NAV history, `?limit=50`. */
  positionTokenAddress?: string;
  /** Static values, for the design preview with no backend behind it. */
  series?: number[];
  color: string;
  /** Adds the soft fill under the line (the spotlight cards use it). */
  fill?: string;
  /** Defaults to the container's width. */
  width?: number;
  height: number;
};

/**
 * A tiny Lightweight Charts instance with everything hidden, for discovery.
 *
 * The TradingView logo is off here ONLY because the site footer carries the
 * TradingView attribution; the full-size charts keep it on. A grid of cards
 * means many chart instances, so a card only builds its chart once it scrolls
 * into view, and removes it on unmount. The chart is built once; new values
 * only reset its data.
 */
export default function Sparkline({ positionTokenAddress, series, color, fill, width, height }: SparklineProps) {
  const el = useRef<HTMLDivElement>(null);
  const line = useRef<ISeriesApi<"Line" | "Area"> | null>(null);
  const chart = useRef<IChartApi | null>(null);
  const [visible, setVisible] = useState(false);
  /** bumps when a chart is (re)built, so the data effects re-apply onto it */
  const [built, setBuilt] = useState(0);

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "120px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const node = el.current;
    if (!visible || !node) return;

    const c = createChart(node, {
      ...(width ? { width, height } : { autoSize: true }),
      layout: { background: { color: "transparent" }, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: { visible: false },
      handleScroll: false,
      handleScale: false,
      crosshair: { mode: CrosshairMode.Hidden },
    });
    const common = {
      lineWidth: 2 as const,
      lineType: LineType.WithSteps,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    };
    line.current = fill
      ? c.addSeries(AreaSeries, { ...common, lineColor: color, topColor: fill, bottomColor: "rgba(0,0,0,0)" })
      : c.addSeries(LineSeries, { ...common, color });
    chart.current = c;
    setBuilt((n) => n + 1);

    return () => {
      c.remove();
      chart.current = null;
      line.current = null;
    };
  }, [visible, color, fill, width, height]);

  // live: the downsampled NAV history
  useEffect(() => {
    if (!built || !positionTokenAddress) return;
    let cancelled = false;
    getNavHistory(positionTokenAddress, SPARK_POINTS)
      .then((history) => {
        if (cancelled || !line.current) return;
        line.current.setData(toLineData(history));
        chart.current?.timeScale().fitContent();
      })
      .catch(() => {
        // an empty sparkline beats a broken card
      });
    return () => {
      cancelled = true;
    };
  }, [built, positionTokenAddress]);

  // preview: static values, indexed as time since they carry no timestamps
  useEffect(() => {
    if (!built || positionTokenAddress || !series?.length || !line.current) return;
    line.current.setData(series.map((value, i) => ({ time: (i + 1) as UTCTimestamp, value })));
    chart.current?.timeScale().fitContent();
  }, [built, positionTokenAddress, series]);

  return <div ref={el} aria-hidden="true" style={{ width: width ?? "100%", height }} />;
}
