"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { Timeframe } from "@/lib/perplMarketData";
import type { LiveBar, ScaleMode } from "../charts/TradeChart";
import { RANGES, TIMEFRAMES, cat, volFmt } from "./data";
import type { MarketView } from "./derive";
import type { TradeEngine } from "./engine";
import { Disc, MONO } from "./shared";

// Lightweight Charts touches `window`, so the chart renders client-side only.
const TradeChart = dynamic(() => import("../charts/TradeChart"), { ssr: false });

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The design's timeframe pills, in Perpl's candle resolutions. */
const PERPL_TF: Record<string, Timeframe> = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1D": "1d" };

/** The footer's range pills, as a trailing window. */
const DAY = 86_400;
const RANGE_SEC: Record<string, number> = {
  "5y": 5 * 365 * DAY,
  "1y": 365 * DAY,
  "6m": 182 * DAY,
  "3m": 91 * DAY,
  "1m": 30 * DAY,
  "5d": 5 * DAY,
  "1d": DAY,
};

const TOGGLE = (on: boolean): React.CSSProperties => ({
  fontFamily: MONO,
  fontSize: 10.5,
  color: on ? "#d8d4e6" : "#8e86a3",
  cursor: "pointer",
  background: "none",
  border: "none",
  padding: 0,
});

/**
 * The candle chart: TradingView Lightweight Charts over live Perpl market data,
 * inside the design's header (symbol, OHLC readout, timeframes) and footer
 * (ranges, clock, scale modes).
 */
export default function Chart({ engine, mkt }: { engine: TradeEngine; mkt: MarketView }) {
  const { st, set } = engine;
  const { dp } = mkt;
  const market = cat(st.market).live;
  const marketId = market?.venueMarketId;

  const [bar, setBar] = useState<LiveBar | null>(null);
  const [scaleMode, setScaleMode] = useState<ScaleMode>("normal");
  const [autoScale, setAutoScale] = useState(true);
  const onBar = useCallback(
    (b: LiveBar) => {
      // a bar still in flight from the market just switched away from
      if (b.market !== marketId) return;
      setBar(b);
    },
    [marketId],
  );

  // a readout from the previous market would be wrong for a frame; blank it instead
  const [shownFor, setShownFor] = useState(marketId);
  if (shownFor !== marketId) {
    setShownFor(marketId);
    setBar(null);
  }

  // The footer clock: local, so the screen itself never re-renders for it. Blank until mounted so hydration matches.
  const [clockMs, setClockMs] = useState(0);
  useEffect(() => {
    const tick = () => setClockMs(Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const chg = bar && bar.ref ? (bar.c / bar.ref - 1) * 100 : 0;
  const chgColor = chg >= 0 ? "#4caf50" : "#e8543a";
  const fmt = (n: number | undefined) => (n === undefined ? "—" : n.toFixed(dp));

  const now = new Date(clockMs);
  const clock = clockMs ? `${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}:${pad2(now.getUTCSeconds())}` : "--:--:--";

  return (
    <div
      className="laxu-chart"
      style={{
        flex: 1,
        minHeight: 560,
        background: "#0a0813",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 14,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* header: symbol, live dot, OHLC readout, timeframe pills */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "8px 10px",
          flexWrap: "wrap",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <Disc sym={st.market} size={17} font={9} />
        <div style={{ fontFamily: MONO, fontSize: 12, fontWeight: 500, color: "#d8d4e6", whiteSpace: "nowrap" }}>
          {st.market} &middot; {st.tf} &middot; perpl
        </div>
        <span
          style={{
            flex: "none",
            width: 9,
            height: 9,
            borderRadius: "50%",
            border: "2px solid #2fd18c",
            boxSizing: "border-box",
            animation: "laxu-pulse 1.8s ease-in-out infinite",
          }}
        />
        <div style={{ fontFamily: MONO, fontSize: 11, color: chgColor }}>
          O{fmt(bar?.o)} H{fmt(bar?.h)} L{fmt(bar?.l)} C{fmt(bar?.c)}{" "}
          {bar ? (
            <>
              {(chg >= 0 ? "+" : "−") + Math.abs(bar.c - bar.ref).toFixed(dp)} ({(chg >= 0 ? "+" : "") + chg.toFixed(2)}%)
            </>
          ) : null}
          <span style={{ color: "#8e86a3" }}> &middot; Vol {volFmt(bar?.v ?? 0)}</span>
        </div>
        <div style={{ flex: 1, minWidth: 6 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
          {TIMEFRAMES.map((t) => (
            <div
              key={t}
              onClick={() => set("tf", t)}
              style={{
                fontFamily: MONO,
                fontSize: 10.5,
                fontWeight: 600,
                padding: "4px 7px",
                borderRadius: 6,
                cursor: "pointer",
                transition: "background 0.2s ease",
                background: st.tf === t ? "rgba(150,112,255,0.4)" : "transparent",
                color: st.tf === t ? "#fdfbf7" : "#a79bd0",
              }}
            >
              {t}
            </div>
          ))}
        </div>
      </div>

      <TradeChart
        market={market}
        timeframe={PERPL_TF[st.tf] ?? "15m"}
        windowSec={RANGE_SEC[st.range] ?? null}
        scaleMode={scaleMode}
        autoScale={autoScale}
        onBar={onBar}
      />

      {/* footer: range pills, clock, scale modes and the chart-provider credit */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderTop: "1px solid rgba(255,255,255,0.06)",
          flexWrap: "wrap",
        }}
      >
        {RANGES.map((r) => (
          <div
            key={r}
            onClick={() => set("range", r)}
            style={{
              fontFamily: MONO,
              fontSize: 10.5,
              fontWeight: 500,
              padding: "3px 6px",
              borderRadius: 5,
              cursor: "pointer",
              color: st.range === r ? "#fdfbf7" : "#8e86a3",
              background: st.range === r ? "rgba(150,112,255,0.35)" : "transparent",
            }}
          >
            {r}
          </div>
        ))}
        <div style={{ flex: 1, minWidth: 6 }} />
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#8e86a3", whiteSpace: "nowrap" }}>{clock} UTC</div>
        <div style={{ width: 1, height: 12, background: "rgba(255,255,255,0.12)" }} />
        <button
          type="button"
          aria-pressed={scaleMode === "percent"}
          onClick={() => setScaleMode((m) => (m === "percent" ? "normal" : "percent"))}
          style={TOGGLE(scaleMode === "percent")}
        >
          %
        </button>
        <button
          type="button"
          aria-pressed={scaleMode === "log"}
          onClick={() => setScaleMode((m) => (m === "log" ? "normal" : "log"))}
          style={TOGGLE(scaleMode === "log")}
        >
          log
        </button>
        <button type="button" aria-pressed={autoScale} onClick={() => setAutoScale((a) => !a)} style={TOGGLE(autoScale)}>
          auto
        </button>
        <a
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.1em",
            color: "#6f6788",
            whiteSpace: "nowrap",
            textDecoration: "none",
          }}
        >
          CHART BY TRADINGVIEW
        </a>
      </div>
    </div>
  );
}
