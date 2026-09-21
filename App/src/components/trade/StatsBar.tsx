"use client";

import { cat, money } from "./data";
import type { MarketView } from "./derive";
import type { TradeEngine } from "./engine";
import { MONO } from "./shared";

/** Mark price plus the six market stats, split by a hairline rule. */
export default function StatsBar({ engine, mkt }: { engine: TradeEngine; mkt: MarketView }) {
  const { st } = engine;
  const m = cat(st.market);
  const { mark, open, chg, chgColor, dp } = mkt;

  const cells = [
    { k: "24H CHANGE", v: (chg >= 0 ? "+" : "") + money(Math.abs(mark - open), dp), c: chgColor },
    { k: "FUNDING / 1H", v: "+0.0091%", c: "#2fd18c" },
    { k: "NEXT FUNDING", v: "00:" + String(38 - (st.tick % 38)).padStart(2, "0"), c: "#e3ddf4" },
    { k: "OPEN INTEREST", v: m.oi, c: "#e3ddf4" },
    { k: "24H VOLUME", v: m.vol, c: "#e3ddf4" },
    { k: "LAXU TOKENS", v: m.tok, c: "#ffb765" },
  ];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 0,
        background: "rgba(255,255,255,0.045)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 14,
        padding: "12px 16px",
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingRight: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" }}>MARK</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 600, letterSpacing: "-0.01em", color: chgColor }}>
            {money(mark, dp)}
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: chgColor }}>
            {(chg >= 0 ? "+" : "") + chg.toFixed(2)}%
          </div>
        </div>
      </div>

      <div style={{ width: 1, height: 34, background: "rgba(255,255,255,0.12)" }} />

      {cells.map((s) => (
        <div key={s.k} style={{ display: "flex", flexDirection: "column", gap: 3, padding: "0 12px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0", whiteSpace: "nowrap" }}>
            {s.k}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", color: s.c }}>{s.v}</div>
        </div>
      ))}
    </div>
  );
}
