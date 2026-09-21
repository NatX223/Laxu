"use client";

import { SIZE_CHIPS, cat, money } from "./data";
import type { MarketView } from "./derive";
import { liqOf, type TradeEngine } from "./engine";
import { MONO } from "./shared";

const LABEL: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" };

const INPUT: React.CSSProperties = {
  fontFamily: MONO,
  color: "#fdfbf7",
  background: "rgba(255,255,255,0.07)",
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 10,
  width: "100%",
  boxSizing: "border-box",
  outline: "none",
};

/** The order ticket column, with the fill toast docked to its bottom edge. */
export default function OrderTicket({ engine, mkt }: { engine: TradeEngine; mkt: MarketView }) {
  const { st, set, lev, freeMargin, actions } = engine;
  const { mark, dp } = mkt;

  const levMax = cat(st.market).lev;
  const notional = st.size * lev;
  const liq = liqOf(mark, st.side, lev);
  const healthPct = Math.max(8, 100 - lev * 4.2);
  const healthColor = healthPct > 66 ? "#2fd18c" : healthPct > 38 ? "#ffb765" : "#ff6b57";
  const healthLabel = healthPct > 66 ? "Healthy" : healthPct > 38 ? "Watch" : "At risk";
  const filling = st.stage === "filling";

  const facts = [
    { k: "Notional", v: money(notional, 0), c: "#fdfbf7" },
    { k: "Entry (est.)", v: money(mark, dp), c: "#fdfbf7" },
    { k: "Liquidation", v: money(liq, dp), c: "#ffb765" },
    { k: "Fees", v: money(notional * 0.00055, 2), c: "#e3ddf4" },
  ];

  const levTicks = [1, Math.round(levMax * 0.25), Math.round(levMax * 0.5), levMax];

  return (
    <div style={{ flex: "0 1 262px", minWidth: 208, display: "flex", flexDirection: "column", gap: 10, position: "relative" }}>
      <div
        style={{
          flex: "1 1 auto",
          background: "rgba(255,255,255,0.045)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 16,
          padding: 14,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          gap: 13,
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, padding: 3, background: "rgba(255,255,255,0.06)", borderRadius: 12 }}>
          {(["long", "short"] as const).map((side) => {
            const active = st.side === side;
            return (
              <div
                key={side}
                onClick={() => set("side", side)}
                style={{
                  textAlign: "center",
                  fontSize: 12.5,
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  padding: "10px 0",
                  borderRadius: 9,
                  cursor: "pointer",
                  transition: "background 0.2s ease",
                  background: active ? (side === "long" ? "#0b7a55" : "#b23a28") : "transparent",
                  color: active ? "#fdfbf7" : "#a79bd0",
                }}
              >
                {side.toUpperCase()}
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {(["market", "limit"] as const).map((t) => (
            <div
              key={t}
              onClick={() => set("otype", t)}
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                letterSpacing: "0.08em",
                cursor: "pointer",
                paddingBottom: 3,
                borderBottom: `2px solid ${st.otype === t ? "#ffb765" : "transparent"}`,
                color: st.otype === t ? "#fdfbf7" : "#7b719e",
              }}
            >
              {t.toUpperCase()}
            </div>
          ))}
        </div>

        {st.otype === "limit" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={LABEL}>LIMIT PRICE</div>
            <input
              value={st.limit ?? mark.toFixed(dp)}
              onChange={(e) => set("limit", e.target.value)}
              style={{ ...INPUT, fontSize: 15, padding: "11px 12px" }}
            />
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={LABEL}>SIZE (USDG)</div>
            <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#998dbd" }}>free {money(freeMargin, 0)}</div>
          </div>
          <input
            value={String(st.size)}
            onChange={(e) => set("size", parseFloat(e.target.value.replace(/[^0-9.]/g, "")) || 0)}
            style={{ ...INPUT, fontSize: 17, fontWeight: 600, padding: 12 }}
          />
          <div style={{ display: "flex", gap: 5 }}>
            {SIZE_CHIPS.map((v) => (
              <div
                key={v}
                onClick={() => set("size", v)}
                className="laxu-size-chip"
                style={{
                  flex: 1,
                  textAlign: "center",
                  fontFamily: MONO,
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: "#d5c6ff",
                  background: "rgba(255,255,255,0.06)",
                  borderRadius: 7,
                  padding: "6px 0",
                  cursor: "pointer",
                }}
              >
                {v === freeMargin ? "MAX" : "$" + (v >= 1000 ? v / 1000 + "k" : v)}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={LABEL}>LEVERAGE</div>
            <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color: "#ffb765" }}>{lev}&times;</div>
          </div>
          <input
            type="range"
            min={1}
            max={levMax}
            step={1}
            value={lev}
            onChange={(e) => set("lev", Math.min(parseInt(e.target.value, 10), levMax))}
            style={{ width: "100%", height: 22, cursor: "pointer" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 9.5, color: "#998dbd" }}>
            {levTicks.map((v, i) => (
              <span key={i}>{v}&times;</span>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 1, background: "rgba(255,255,255,0.09)", borderRadius: 10, overflow: "hidden" }}>
          {facts.map((f) => (
            <div
              key={f.k}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "9px 11px", background: "#241c46" }}
            >
              <div style={{ fontSize: 11, fontWeight: 600, color: "#a79bd0" }}>{f.k}</div>
              <div style={{ fontFamily: MONO, fontSize: 12, color: f.c }}>{f.v}</div>
            </div>
          ))}
        </div>

        <div
          onClick={actions.placeOrder}
          className="laxu-submit"
          style={{
            textAlign: "center",
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: "0.02em",
            padding: "15px 0",
            borderRadius: 12,
            cursor: "pointer",
            transition: "transform 0.2s ease, background 0.2s ease",
            color: "#fdfbf7",
            background: filling ? "rgba(255,255,255,0.14)" : st.side === "long" ? "#0b7a55" : "#b23a28",
          }}
        >
          {filling ? "Routing to Arcus…" : (st.side === "long" ? "Buy / Long " : "Sell / Short ") + st.market}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={LABEL}>MARGIN HEALTH</div>
            <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: healthColor }}>{healthLabel}</div>
          </div>
          <div style={{ height: 6, borderRadius: 99, background: "rgba(255,255,255,0.1)", overflow: "hidden" }}>
            <div style={{ height: "100%", borderRadius: 99, transition: "width 0.4s ease", background: healthColor, width: healthPct + "%" }} />
          </div>
        </div>
      </div>

      {st.notice && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 4,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "13px 14px",
            background: "#0b7a55",
            borderRadius: 12,
            boxShadow: "0 10px 26px rgba(0,0,0,0.42)",
            animation: "laxu-rise 0.3s ease both",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fdfbf7" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 13 9 18 20 6" />
          </svg>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "#fdfbf7" }}>{st.notice}</div>
        </div>
      )}
    </div>
  );
}
