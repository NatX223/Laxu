"use client";

import type { MarketView } from "./derive";
import { rnd, type TradeEngine } from "./engine";
import { MONO } from "./shared";

/** Depth histogram: nine bids ramping up, nine asks ramping down. */
const DEPTH_BARS = [
  ...Array.from({ length: 9 }, (_, i) => ({ c: "rgba(47,209,140,0.55)", h: Math.round(28 + (i / 8) * 72) + "%" })),
  ...Array.from({ length: 9 }, (_, i) => ({ c: "rgba(255,107,87,0.55)", h: Math.round(100 - (i / 8) * 72) + "%" })),
];

const HEAD: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em", color: "#a79bd0" };

/** Order book / tape, plus the depth card below it. */
export default function BookPanel({
  engine,
  mkt,
  showDepth = true,
}: {
  engine: TradeEngine;
  mkt: MarketView;
  showDepth?: boolean;
}) {
  const { st, set } = engine;
  const { mark, chgColor, dp } = mkt;

  // ladder sizes come from the deterministic hash so they only move with ticks
  const asks: { p: string; s: string; depth: string }[] = [];
  let cum = 0;
  for (let i = 7; i >= 0; i--) {
    const sz = 4 + rnd(i + 30, st.tick) * 28;
    cum += sz;
    asks.push({ p: (mark * (1 + 0.0004 * (i + 1))).toFixed(dp), s: sz.toFixed(2), depth: Math.min(100, cum * 2.4) + "%" });
  }
  const bids: { p: string; s: string; depth: string }[] = [];
  cum = 0;
  for (let i = 0; i < 8; i++) {
    const sz = 4 + rnd(i + 70, st.tick) * 28;
    cum += sz;
    bids.push({ p: (mark * (1 - 0.0004 * (i + 1))).toFixed(dp), s: sz.toFixed(2), depth: Math.min(100, cum * 2.4) + "%" });
  }

  const tapes = (st.tapes[st.market] || []).map((t, i) => ({
    key: i,
    p: t.p.toFixed(dp),
    s: t.s.toFixed(2),
    t: t.t,
    c: t.buy ? "#58e0a6" : "#ff8f7d",
  }));

  return (
    <div style={{ flex: "0 1 184px", minWidth: 128, display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          flex: "none",
          background: "rgba(255,255,255,0.045)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 16,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
          {(["book", "trades"] as const).map((tab) => (
            <div
              key={tab}
              onClick={() => set("tab", tab)}
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.1em",
                cursor: "pointer",
                color: st.tab === tab ? "#fdfbf7" : "#7b719e",
              }}
            >
              {tab.toUpperCase()}
            </div>
          ))}
        </div>

        {st.tab === "book" && (
          <div style={{ display: "flex", flexDirection: "column", padding: "8px 0" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, padding: "0 14px 6px" }}>
              <div style={HEAD}>PRICE</div>
              <div style={{ ...HEAD, textAlign: "right" }}>SIZE</div>
            </div>

            {asks.map((a, i) => (
              <Ladder key={`a${i}`} row={a} ink="#ff8f7d" fill="rgba(255,107,87,0.16)" />
            ))}

            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 8,
                padding: "9px 14px",
                margin: "6px 0",
                background: "rgba(255,255,255,0.06)",
              }}
            >
              <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, color: chgColor }}>
                ${mark.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#a79bd0" }}>spread {(mark * 0.0008).toFixed(dp)}</div>
            </div>

            {bids.map((b, i) => (
              <Ladder key={`b${i}`} row={b} ink="#58e0a6" fill="rgba(47,209,140,0.16)" />
            ))}
          </div>
        )}

        {st.tab === "trades" && (
          <div style={{ display: "flex", flexDirection: "column", padding: "8px 0" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 0.8fr", gap: 6, padding: "0 14px 6px" }}>
              <div style={HEAD}>PRICE</div>
              <div style={{ ...HEAD, textAlign: "right" }}>SIZE</div>
              <div style={{ ...HEAD, textAlign: "right" }}>TIME</div>
            </div>
            {tapes.map((t) => (
              <div key={t.key} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 0.8fr", gap: 6, padding: "3.5px 14px" }}>
                <div style={{ fontFamily: MONO, fontSize: 11.5, color: t.c }}>{t.p}</div>
                <div style={{ fontFamily: MONO, fontSize: 11.5, color: "#e3ddf4", textAlign: "right" }}>{t.s}</div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: "#998dbd", textAlign: "right" }}>{t.t}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showDepth && (
      <div
        style={{
          flex: "1 1 auto",
          minHeight: 120,
          background: "rgba(255,255,255,0.045)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 16,
          padding: "12px 14px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" }}>DEPTH</div>
          <div style={{ fontFamily: MONO, fontSize: 10, color: "#998dbd" }}>&plusmn;0.4%</div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 2, flex: 1, minHeight: 56 }}>
          {DEPTH_BARS.map((d, i) => (
            <div key={i} style={{ flex: 1, borderRadius: "2px 2px 0 0", background: d.c, height: d.h }} />
          ))}
        </div>
      </div>
      )}
    </div>
  );
}

/** One book row: the cumulative-depth wash sits behind price and size. */
function Ladder({ row, ink, fill }: { row: { p: string; s: string; depth: string }; ink: string; fill: string }) {
  return (
    <div style={{ position: "relative", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, padding: "3.5px 14px" }}>
      <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, background: fill, width: row.depth }} />
      <div style={{ position: "relative", fontFamily: MONO, fontSize: 11.5, color: ink }}>{row.p}</div>
      <div style={{ position: "relative", fontFamily: MONO, fontSize: 11.5, color: "#e3ddf4", textAlign: "right" }}>{row.s}</div>
    </div>
  );
}
