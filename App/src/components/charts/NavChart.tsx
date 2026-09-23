"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  LineSeries,
  LineType,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from "lightweight-charts";
import { getNavHistory, type NavHistory } from "@/lib/api";
import { applyWindow, baseChartOptions, entryLine, FROST } from "./theme";

/** Matches the reporting cadence — a new point lands at most once a minute. */
const REFRESH_MS = 60_000;

export type NavChartProps = {
  /** Live mode: history from the backend's indexed reports, refreshed every 60s. */
  positionTokenAddress?: string;
  /** Static mode, for the design preview with no backend behind it. */
  history?: NavHistory;
  /** trailing seconds to show; null shows the whole history */
  windowSec?: number | null;
  height?: number;
  onNav?: (last: number, entry: number, closed: boolean, count: number) => void;
};

/**
 * Entry first, so the line starts on the baseline, then every report. Lightweight
 * Charts rejects repeated or out-of-order times, so those are collapsed.
 */
export function toLineData(history: NavHistory): LineData<UTCTimestamp>[] {
  const raw = [history.entry, ...history.points].sort((a, b) => a.time - b.time);
  const out: LineData<UTCTimestamp>[] = [];
  for (const point of raw) {
    const datum = { time: point.time as UTCTimestamp, value: Number(point.navPerToken) };
    if (out.length && out[out.length - 1].time === datum.time) out[out.length - 1] = datum;
    else out.push(datum);
  }
  return out;
}

/**
 * Position NAV per token — STEPPED, never smoothed: the flat stretches between
 * reports are what the contract actually saw. Every point is the contract's
 * own totalAssets()/totalSupply() at that report. Closed positions end at the
 * final point, marked, and stop refreshing.
 */
export default function NavChart({ positionTokenAddress, history, windowSec, height = 190, onNav }: NavChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Line"> | null>(null);
  const [fetched, setFetched] = useState<NavHistory | null>(null);
  // static mode follows the prop; live mode what the backend last returned
  const data = history ?? fetched;
  const [error, setError] = useState<string | null>(null);
  const onNavRef = useRef(onNav);
  const windowRef = useRef(windowSec);
  useEffect(() => {
    onNavRef.current = onNav;
    windowRef.current = windowSec;
  });

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      ...baseChartOptions,
      localization: { priceFormatter: (p: number) => p.toFixed(4) },
    });
    series.current = c.addSeries(LineSeries, {
      color: FROST.violet,
      lineWidth: 2,
      lineType: LineType.WithSteps,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  // live mode: fetch, then poll until the position closes
  useEffect(() => {
    if (!positionTokenAddress) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        const next = await getNavHistory(positionTokenAddress);
        if (cancelled) return;
        setFetched(next);
        setError(null);
        if (!next.closed) timer = setTimeout(load, REFRESH_MS);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not load NAV history");
        timer = setTimeout(load, REFRESH_MS);
      }
    };
    void load();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [positionTokenAddress]);

  useEffect(() => {
    const s = series.current;
    if (!s || !data) return;
    const points = toLineData(data);
    s.setData(points);

    const entry = Number(data.entry.navPerToken);
    const line = s.createPriceLine({ ...entryLine, price: entry });
    const last = points[points.length - 1];
    const markers =
      data.closed && last
        ? createSeriesMarkers(s, [{ time: last.time, position: "inBar", shape: "circle", color: FROST.rose, text: "Closed" }])
        : null;

    if (chart.current) applyWindow(chart.current, windowRef.current);
    if (last) onNavRef.current?.(last.value, entry, data.closed, data.points.length);

    return () => {
      s.removePriceLine(line);
      markers?.detach();
    };
  }, [data]);

  useEffect(() => {
    if (chart.current) applyWindow(chart.current, windowSec);
  }, [windowSec]);

  return (
    <div style={{ position: "relative", height }}>
      <div ref={el} style={{ position: "absolute", inset: 0 }} />
      {error && !data && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 12, color: FROST.muted }}>
          {error}
        </div>
      )}
    </div>
  );
}
