"use client";

import type { ReactNode } from "react";
import { CELL_BG, HAIRLINE, MONO, Panel } from "./shared";
import type { PositionEngine } from "./engine";

/** The dashed reference line's floating caption. */
function Marker({
  top,
  side,
  border,
  ink,
  children,
}: {
  top: string;
  side: "left" | "right";
  border: string;
  ink: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: side === "left" ? 8 : undefined,
        right: side === "right" ? 8 : undefined,
        top,
        transform: "translateY(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 9px",
        borderRadius: 99,
        background: "rgba(36,28,70,0.88)",
        border: `1px solid ${border}`,
        fontFamily: MONO,
        fontSize: 10.5,
        color: ink,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </div>
  );
}

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

function Axis({ axis }: { axis: string[] }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 10, color: "#6f66a0" }}>
      {axis.map((a, i) => (
        <div key={i}>{a}</div>
      ))}
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

/**
 * The underlying beside the position's own NAV — the whole point of the
 * screen, since the second is the first run through the leverage.
 */
export default function LeverageView({ engine }: { engine: PositionEngine }) {
  const { vals, setRange } = engine;
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
          <div style={{ fontSize: 12, fontWeight: 600, color: "#a79bd0" }}>{vals.leverageLine}</div>
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
            title={vals.assetTitle}
            source="SOURCE · ARCUS MARKET DATA API"
            last={vals.assetLast}
            chg={vals.assetChg}
            chgColor={vals.assetColor}
          />
          <div style={{ position: "relative", height: 190 }}>
            <svg
              viewBox="0 0 600 190"
              preserveAspectRatio="none"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="lxAsset" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={vals.assetColor} stopOpacity="0.26" />
                  <stop offset="100%" stopColor={vals.assetColor} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={vals.assetArea} fill="url(#lxAsset)" />
              <path
                d={vals.assetLine}
                fill="none"
                stroke={vals.assetColor}
                strokeWidth="1.9"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <line
                x1="0"
                x2="600"
                y1={vals.assetEntryY}
                y2={vals.assetEntryY}
                stroke="#ffd9a0"
                strokeWidth="1.2"
                strokeDasharray="5 4"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={vals.assetEntryX}
                cy={vals.assetEntryY}
                r="4"
                fill="#ffd9a0"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            <Marker top={vals.assetEntryTop} side="left" border="rgba(255,217,160,0.5)" ink="#ffd9a0">
              ENTRY {vals.entryPrice}
            </Marker>
          </div>
          <Axis axis={vals.axis} />
        </div>

        <div style={CARD}>
          <ChartHead
            title="Position NAV"
            source={`SOURCE · LAXU onReport INDEX · ${vals.reportCount} REPORTS`}
            last={vals.navLast}
            chg={vals.navChg}
            chgColor={vals.pnlColor}
          />
          <div style={{ position: "relative", height: 190 }}>
            <svg
              viewBox="0 0 600 190"
              preserveAspectRatio="none"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="lxNav" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={vals.pnlColor} stopOpacity="0.26" />
                  <stop offset="100%" stopColor={vals.pnlColor} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={vals.navArea} fill="url(#lxNav)" />
              {/* mitred and butted, so the steps stay square */}
              <path
                d={vals.navLine}
                fill="none"
                stroke={vals.pnlColor}
                strokeWidth="1.9"
                strokeLinejoin="miter"
                strokeLinecap="butt"
                vectorEffect="non-scaling-stroke"
              />
              <line
                x1="0"
                x2="600"
                y1={vals.navBaseY}
                y2={vals.navBaseY}
                stroke="#ffd9a0"
                strokeWidth="1.2"
                strokeDasharray="5 4"
                vectorEffect="non-scaling-stroke"
              />
              {vals.navDots.map((d, i) => (
                <circle key={i} cx={d.x} cy={d.y} r="2" fill="#c2b6e4" opacity="0.55" vectorEffect="non-scaling-stroke" />
              ))}
              {vals.isClosed && (
                <circle
                  cx={vals.navEndX}
                  cy={vals.navEndY}
                  r="4.5"
                  fill="#ff7d92"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
            <Marker top={vals.navBaseTop} side="left" border="rgba(255,217,160,0.5)" ink="#ffd9a0">
              DEPOSIT {vals.depositLabel}
            </Marker>
            {vals.isClosed && (
              <Marker top={vals.navEndTop} side="right" border="rgba(255,125,146,0.5)" ink="#ff7d92">
                CLOSED {vals.navLast}
              </Marker>
            )}
          </div>
          <Axis axis={vals.axis} />
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
        NAV is replayed from every <span style={{ fontFamily: MONO, color: "#c2b6e4" }}>onReport</span> triple through
        the contract&rsquo;s own <span style={{ fontFamily: MONO, color: "#c2b6e4" }}>totalAssets()</span> &mdash;
        stepped, because the flat stretches are what the contract actually saw.
      </div>
    </Panel>
  );
}
