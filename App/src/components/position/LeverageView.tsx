"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { NavHistory, PublicPosition } from "@/lib/api";
import { CELL_BG, HAIRLINE, MONO, Panel } from "./shared";
import { SUPPLY, usd, type RangeKey, type Series, type Side } from "./data";
import type { PositionEngine } from "./engine";

// Lightweight Charts touches `window`, so both charts render client-side only.
const AssetChart = dynamic(() => import("../charts/AssetChart"), { ssr: false });
const NavChart = dynamic(() => import("../charts/NavChart"), { ssr: false });

const GREEN = "#5fe3a8";
const ROSE = "#ff7d92";

function ChartHead({
  title,
  source,
  last,
  chg,
  chgColor,
}: {
  title: string;
  source: string;
  last: string;
  chg: string;
  chgColor: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: "#fdfbf7" }}>{title}</div>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: "#8f85bd" }}>{source}</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontFamily: MONO, fontSize: 16, fontWeight: 600, color: "#fdfbf7" }}>{last}</div>
        <div style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, color: chgColor }}>{chg}</div>
      </div>
    </div>
  );
}

const CARD: React.CSSProperties = {
  background: CELL_BG,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: "14px 16px 16px",
};

/** The range pills now set both charts' visible window. */
const RANGE_SEC: Record<RangeKey, number | null> = {
  "24H": 86_400,
  "7D": 7 * 86_400,
  "30D": 30 * 86_400,
  ALL: null,
};

/** How far back the preview's 180 prototype ticks are laid out, ending now. */
const DEMO_SPAN_SEC = 45 * 86_400;

/**
 * The preview has no indexed reports, so the prototype's replayed ones are laid
 * on a real clock and expressed per token — the same shape nav-history returns.
 */
function demoHistory(series: Series, closed: boolean): { history: NavHistory; entryTime: number } {
  const end = Math.floor(Date.now() / 1000);
  const last = series.asset.length - 1;
  const at = (i: number) => end - Math.round(((last - i) / last) * DEMO_SPAN_SEC);
  // derive() cuts a closed position's history at 84%
  const cut = closed ? Math.floor(series.asset.length * 0.84) : series.asset.length;
  const reports = series.reports.filter((r) => r.i < cut);
  return {
    entryTime: at(0),
    history: {
      entry: { time: at(0), navPerToken: "1.000000" },
      points: reports.map((r) => ({ time: at(r.i), navPerToken: (r.nav / SUPPLY).toFixed(6) })),
      closed,
    },
  };
}

function Loading() {
  return (
    <div style={{ height: 190, display: "grid", placeItems: "center", fontSize: 12, color: "#8f85bd" }}>
      Loading position&hellip;
    </div>
  );
}

const pct = (value: number, base: number) => (base ? (value / base - 1) * 100 : 0);
const signed = (n: number, digits: number) => (n >= 0 ? "+" : "") + n.toFixed(digits) + "%";

/**
 * The underlying beside the position's own NAV — the whole point of the
 * screen, since the second is the first run through the leverage. With a
 * minted token behind the page (`live`), both are real: Arcus candles and the
 * indexer's per-report NAV. Without one, the candles are still live Arcus ETH
 * and the NAV line replays the prototype's reports.
 */
export default function LeverageView({
  engine,
  live,
  awaitingLive = false,
  previewSide = "long",
}: {
  engine: PositionEngine;
  live?: PublicPosition | null;
  /** a token address was given but its position hasn't loaded — show neither preview nor live */
  awaitingLive?: boolean;
  /** the prototype's `side` knob, for the preview's entry arrow */
  previewSide?: Side;
}) {
  const { vals, setRange, series } = engine;
  const windowSec = RANGE_SEC[engine.st.range];

  const demo = useMemo(
    () => (live || awaitingLive ? null : demoHistory(series, vals.isClosed)),
    [live, awaitingLive, series, vals.isClosed],
  );

  const [asset, setAsset] = useState<{ last: number; entry: number } | null>(null);
  const [nav, setNav] = useState<{ last: number; entry: number; count: number } | null>(null);
  const onLast = useCallback((last: number, entry: number) => setAsset({ last, entry }), []);
  const onNav = useCallback(
    (last: number, entry: number, _closed: boolean, count: number) => setNav({ last, entry, count }),
    [],
  );

  const market = live?.arcusMarket ?? "ETH-USD";
  const base = live?.symbol ?? market.split("-")[0];
  const side = live?.direction ?? previewSide;

  const assetPct = asset ? pct(asset.last, asset.entry) : 0;
  const navPct = nav ? pct(nav.last, nav.entry) : 0;
  const summary =
    asset && nav
      ? `${base} ${signed(assetPct, 1)}, this position ${signed(navPct, 1)}`
      : live
        ? `${base} · ${live.leverage}× ${live.direction}`
        : vals.leverageLine;

  return (
    <Panel>
      {/* the label and the summary line share one wrapping group, then the ranges */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          padding: "12px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.14em", color: "#c3b8e3" }}>
            LEVERAGE VIEW
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#a79bd0" }}>{summary}</div>
        </div>
        <div style={{ display: "flex", gap: 5 }}>
          {vals.ranges.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              aria-pressed={r.key === engine.st.range}
              style={{
                fontFamily: "inherit",
                fontSize: 11,
                fontWeight: 700,
                padding: "6px 12px",
                borderRadius: 99,
                cursor: "pointer",
                border: `1px solid ${r.border}`,
                background: r.bg,
                color: r.ink,
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: 1,
          background: HAIRLINE,
        }}
      >
        <div style={CARD}>
          <ChartHead
            title={`${base} · underlying`}
            source={`SOURCE · ARCUS MARKET DATA API · ${market}`}
            last={asset ? usd(asset.last) : "—"}
            chg={asset ? `${signed(assetPct, 2)} vs entry` : ""}
            chgColor={assetPct >= 0 ? GREEN : ROSE}
          />
          {awaitingLive ? (
            <Loading />
          ) : (
            <AssetChart
              market={market}
              side={side}
              entryPrice={live?.entryPrice ? Number(live.entryPrice) : null}
              entryTime={live ? live.openedAt : demo?.entryTime}
              windowSec={windowSec}
              onLast={onLast}
            />
          )}
        </div>

        <div style={CARD}>
          <ChartHead
            title="Position NAV · per token"
            source={`SOURCE · LAXU INDEX · totalAssets() / totalSupply() · ${nav?.count ?? vals.reportCount} REPORTS`}
            last={nav ? "$" + nav.last.toFixed(4) : "—"}
            chg={nav ? signed(navPct, 2) : ""}
            chgColor={navPct >= 0 ? GREEN : ROSE}
          />
          {awaitingLive ? (
            <Loading />
          ) : (
            <NavChart
              positionTokenAddress={live?.positionTokenAddress}
              history={demo?.history}
              windowSec={windowSec}
              onNav={onNav}
            />
          )}
        </div>
      </div>

      <div
        style={{
          padding: "10px 16px",
          fontSize: 11.5,
          fontWeight: 500,
          color: "#8f85bd",
          borderTop: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        NAV is the contract&rsquo;s own <span style={{ fontFamily: MONO, color: "#c2b6e4" }}>totalAssets()</span> /{" "}
        <span style={{ fontFamily: MONO, color: "#c2b6e4" }}>totalSupply()</span>, read at every report &mdash;
        stepped, because the flat stretches are what the contract actually saw.
        {!live && !awaitingLive && " Preview: candles are live Arcus ETH; the NAV line replays sample reports."}
      </div>
    </Panel>
  );
}
