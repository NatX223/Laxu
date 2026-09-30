"use client";

import Link from "next/link";
import { money } from "./data";
import { posEquity, posPnl, type TradeEngine } from "./engine";
import { Disc, MONO, SERIF } from "./shared";

/** "Your tokenized positions" — one card per minted position, each linking to its page. */
export default function TokensView({ engine }: { engine: TradeEngine }) {
  const { st } = engine;

  // Arcus's mark; a position without one yet counts at its margin and shows dashes.
  const markOf = (sym: string): number | null => st.px[sym] ?? null;
  const tokenEquity = st.positions.reduce((a, x) => {
    const mark = markOf(x.sym);
    return a + (mark === null ? x.margin : posEquity(x, mark));
  }, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.16em", color: "#ffd9a0" }}>POSITION TOKENS</div>
          <div style={{ fontFamily: SERIF, fontSize: "clamp(30px, 8vw, 40px)", lineHeight: 1, letterSpacing: "-0.02em", color: "#fdfbf7" }}>
            Your <i>tokenized</i> positions
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Summary label="TOKEN EQUITY" value={money(tokenEquity, 0)} ink="#fdfbf7" />
        </div>
      </div>

      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fill, minmax(min(320px, 100%), 1fr))" }}>
        {st.positions.map((x) => {
          const mark = markOf(x.sym);
          const pnl = mark === null ? null : posPnl(x, mark);
          const cells = [
            { k: "ENTRY", v: money(x.entry, 2), c: "#fdfbf7" },
            { k: "MARK", v: mark === null ? "—" : money(mark, 2), c: "#fdfbf7" },
            { k: "EQUITY", v: mark === null ? "—" : money(posEquity(x, mark), 0), c: "#fdfbf7" },
            {
              k: "UNREALIZED",
              v: pnl === null ? "—" : (pnl >= 0 ? "+" : "−") + money(Math.abs(pnl), 0).slice(1),
              c: pnl === null ? "#fdfbf7" : pnl >= 0 ? "#2fd18c" : "#ff6b57",
            },
          ];

          return (
            <Link
              key={x.id}
              href={`/position/${x.addr}`}
              style={{
                display: "block",
                borderRadius: 18,
                overflow: "hidden",
                cursor: "pointer",
                color: "inherit",
                textDecoration: "none",
                border: "1px solid rgba(255,255,255,0.12)",
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
                  background: "rgba(150,112,255,0.42)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Disc sym={x.sym} size={26} font={12} />
                  <div style={{ fontFamily: SERIF, fontSize: 19, color: "#fdfbf7" }}>
                    {x.nickname || `${x.sym} ${x.side}, ${x.lev}×`}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    padding: "5px 10px",
                    borderRadius: 99,
                    background: "#fdfbf7",
                    color: "#6f45e0",
                  }}
                >
                  ERC-20
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
                  {`${x.addr.slice(0, 6)}…${x.addr.slice(-4)}`}
                </div>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: "#ffd9a0" }}>
                  {x.status === "open" ? "Borrow · List · Close →" : "Settling →"}
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {st.positions.length === 0 && (
        <div
          style={{
            padding: "40px 16px",
            textAlign: "center",
            fontSize: 13,
            fontWeight: 500,
            color: "#d5c6ff",
            background: "rgba(255,255,255,0.045)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 16,
          }}
        >
          No positions yet. Open your first trade.
        </div>
      )}
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
