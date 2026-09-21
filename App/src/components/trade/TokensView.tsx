"use client";

import { money } from "./data";
import { posEquity, posPnl, type TradeEngine } from "./engine";
import { Disc, MONO, SERIF } from "./shared";

/** "Your minted positions" — one card per position, tokenized or not. */
export default function TokensView({ engine }: { engine: TradeEngine }) {
  const { st, setSt } = engine;

  const markOf = (sym: string, fallback: number) => st.px[sym] ?? fallback;
  const tokenEquity = st.positions
    .filter((x) => x.tokenized)
    .reduce((a, x) => a + posEquity(x, markOf(x.sym, x.entry)), 0);
  const borrowedTotal = st.positions.reduce((a, x) => a + x.borrowed, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.16em", color: "#ffd9a0" }}>POSITION TOKENS</div>
          <div style={{ fontFamily: SERIF, fontSize: 40, lineHeight: 1, letterSpacing: "-0.02em", color: "#fdfbf7" }}>
            Your <i>minted</i> positions
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Summary label="TOKEN EQUITY" value={money(tokenEquity, 0)} ink="#fdfbf7" />
          <Summary label="BORROWED" value={money(borrowedTotal, 0)} ink="#ffb765" />
        </div>
      </div>

      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
        {st.positions.map((x) => {
          const mark = markOf(x.sym, x.entry);
          const pnl = posPnl(x, mark);
          const cells = [
            { k: "ENTRY", v: money(x.entry, 2), c: "#fdfbf7" },
            { k: "MARK", v: money(mark, 2), c: "#fdfbf7" },
            { k: "EQUITY", v: money(posEquity(x, mark), 0), c: "#fdfbf7" },
            {
              k: "UNREALIZED",
              v: (pnl >= 0 ? "+" : "−") + money(Math.abs(pnl), 0).slice(1),
              c: pnl >= 0 ? "#2fd18c" : "#ff6b57",
            },
          ];

          return (
            <div
              key={x.id}
              onClick={() => setSt((s) => ({ ...s, sel: x.id, view: "trade" }))}
              style={{
                borderRadius: 18,
                overflow: "hidden",
                cursor: "pointer",
                border: `1px solid ${x.id === st.sel ? "rgba(255,183,101,0.6)" : "rgba(255,255,255,0.12)"}`,
                background: "rgba(255,255,255,0.045)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "14px 16px",
                  background: x.tokenized ? "rgba(150,112,255,0.42)" : "rgba(255,255,255,0.07)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Disc sym={x.sym} size={26} font={12} />
                  <div style={{ fontFamily: SERIF, fontSize: 19, color: "#fdfbf7" }}>
                    {`${x.sym} ${x.side}, ${x.lev}×`}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    padding: "5px 10px",
                    borderRadius: 99,
                    background: x.tokenized ? "#fdfbf7" : "rgba(255,255,255,0.12)",
                    color: x.tokenized ? "#6f45e0" : "#a79bd0",
                  }}
                >
                  {x.tokenized ? "ERC-20" : "NOT MINTED"}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: "rgba(255,255,255,0.09)" }}>
                {cells.map((c) => (
                  <div key={c.k} style={{ padding: "12px 16px", background: "#241c46", display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em", color: "#a79bd0" }}>{c.k}</div>
                    <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 500, color: c.c }}>{c.v}</div>
                  </div>
                ))}
              </div>

              <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div style={{ fontFamily: MONO, fontSize: 11, color: "#a79bd0" }}>
                  {x.tokenized ? (x.alias ? `${x.alias} · ${x.addr}` : x.addr) : "no token yet"}
                </div>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: x.tokenized ? "#ffd9a0" : "#d5c6ff" }}>
                  {x.tokenized
                    ? x.borrowed
                      ? "Borrowed " + money(x.borrowed, 0)
                      : "Borrow · Sell · Buy-in"
                    : "Mint token →"}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Summary({ label, value, ink }: { label: string; value: string; ink: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "12px 18px",
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 12,
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 17, fontWeight: 600, color: ink }}>{value}</div>
    </div>
  );
}
