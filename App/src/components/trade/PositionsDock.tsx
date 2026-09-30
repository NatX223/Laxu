"use client";

import Link from "next/link";
import { money } from "./data";
import { liqOf, posPnl, type TradeEngine } from "./engine";
import { Disc, MONO } from "./shared";

const COLS = "minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.05fr) minmax(0, 1.5fr)";
const HEADS = ["MARKET", "SIZE · ENTRY", "MARK · LIQ", "UNREALIZED", "LAXU STATE"];

/** Truncating cell text — every dock column clips rather than wraps. */
const CLIP: React.CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

const CHIP: React.CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: "0.06em",
  padding: "5px 8px",
  borderRadius: 99,
  whiteSpace: "nowrap",
};

/** The lit panel under the workspace: the user's minted positions, each linking to its page. */
export default function PositionsDock({ engine }: { engine: TradeEngine }) {
  const { st } = engine;

  return (
    <div style={{ padding: "0 8px 8px 8px" }}>
      <div
        style={{
          background: "linear-gradient(120deg, rgba(150,112,255,0.2) 0%, rgba(255,183,101,0.12) 100%)",
          border: "1px solid rgba(213,198,255,0.34)",
          borderRadius: 16,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "13px 16px",
            flexWrap: "wrap",
            borderBottom: "1px solid rgba(213,198,255,0.26)",
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", color: "#ffd9a0", whiteSpace: "nowrap" }}>
            POSITIONS <span style={{ color: "#fdfbf7" }}>({st.positions.length})</span>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 11, fontWeight: 600, color: "#d5c6ff" }}>
            Every position is a token: open one to borrow against it, list it or close it
          </div>
        </div>

        <div className="laxu-dock-table">
        <div
          className="laxu-dock-grid"
          style={{
            display: "grid",
            gap: 8,
            padding: "10px 12px",
            gridTemplateColumns: COLS,
            borderBottom: "1px solid rgba(213,198,255,0.2)",
          }}
        >
          {HEADS.map((h) => (
            <div key={h} style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "#d5c6ff", ...CLIP }}>
              {h}
            </div>
          ))}
        </div>

        {st.positions.map((x) => {
          // Arcus's mark; until it has answered, mark and PnL read as dashes.
          const mark = st.px[x.sym] ?? null;
          const pnl = mark === null ? null : posPnl(x, mark);
          const pct = pnl !== null && x.margin > 0 ? (pnl / x.margin) * 100 : 0;
          const pnlColor = pnl === null ? "#e3ddf4" : pnl >= 0 ? "#2fd18c" : "#ff6b57";
          const closing = x.status !== "open";

          return (
            <Link
              key={x.id}
              href={`/position/${x.addr}`}
              className="laxu-dock-row laxu-dock-grid"
              style={{
                display: "grid",
                gap: 8,
                padding: "12px 12px",
                alignItems: "center",
                gridTemplateColumns: COLS,
                cursor: "pointer",
                color: "inherit",
                textDecoration: "none",
                borderBottom: "1px solid rgba(213,198,255,0.16)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <Disc sym={x.sym} size={24} font={11} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#fdfbf7", ...CLIP }}>{x.sym}-PERP</div>
                  <div
                    style={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      letterSpacing: "0.06em",
                      color: x.side === "long" ? "#58e0a6" : "#ff8f7d",
                      ...CLIP,
                    }}
                  >
                    {x.side.toUpperCase()} &middot; {x.lev}&times;
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <div style={{ fontFamily: MONO, fontSize: 12.5, color: "#e3ddf4", ...CLIP }}>
                  {x.qty.toLocaleString("en-US", { maximumFractionDigits: 4 })} {x.sym}
                </div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: "#c3b8e3", ...CLIP }}>{money(x.entry, 2)}</div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <div style={{ fontFamily: MONO, fontSize: 12.5, color: "#e3ddf4", ...CLIP }}>{mark === null ? "—" : money(mark, 2)}</div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: "#ffb765", ...CLIP }}>
                  {money(liqOf(x.entry, x.side, x.lev), 0)}
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, overflow: "hidden" }}>
                <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", color: pnlColor }}>
                  {pnl === null ? "—" : (pnl >= 0 ? "+" : "−") + money(Math.abs(pnl), 2).slice(1)}
                </div>
                {pnl !== null && (
                  <div style={{ fontFamily: MONO, fontSize: 11, color: pnlColor }}>
                    {(pct >= 0 ? "+" : "−") + Math.abs(pct).toFixed(1)}%
                  </div>
                )}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", minWidth: 0, overflow: "hidden" }}>
                <div style={{ ...CHIP, background: "rgba(150,112,255,0.3)", color: "#d5c6ff" }}>TOKENIZED</div>
                {closing ? (
                  <div style={{ ...CHIP, background: "rgba(255,255,255,0.08)", color: "#a79bd0" }}>
                    {x.liquidated ? "LIQUIDATED" : "CLOSING"}
                  </div>
                ) : (
                  x.listed && <div style={{ ...CHIP, background: "rgba(255,183,101,0.16)", color: "#ffd9a0" }}>LISTED</div>
                )}
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "#ffd9a0", whiteSpace: "nowrap" }}>Open &rarr;</div>
              </div>
            </Link>
          );
        })}

        </div>

        {st.positions.length === 0 && (
          <div style={{ padding: "30px 16px", textAlign: "center", fontSize: 13, fontWeight: 500, color: "#d5c6ff" }}>
            No positions yet. Open your first trade.
          </div>
        )}
      </div>
    </div>
  );
}
