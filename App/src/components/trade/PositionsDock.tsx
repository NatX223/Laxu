"use client";

import { kmoney, money } from "./data";
import { liqOf, posPnl, type TradeEngine } from "./engine";
import MintModal from "./MintModal";
import { Disc, MONO } from "./shared";

const COLS = "minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.05fr) minmax(0, 1.5fr)";
const HEADS = ["MARKET", "SIZE · ENTRY", "MARK · LIQ", "UNREALIZED", "LAXU STATE"];

/** Truncating cell text — every dock column clips rather than wraps. */
const CLIP: React.CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

/** The lit panel under the workspace: open positions and the tokenize action. */
export default function PositionsDock({ engine }: { engine: TradeEngine }) {
  const { st, setSt, actions } = engine;

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
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", color: "#c3b8e3" }}>ORDERS (0)</div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", color: "#c3b8e3" }}>FILLS</div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 11, fontWeight: 600, color: "#d5c6ff" }}>
            Tokenize a position to unlock borrowing, sale and buy-in
          </div>
        </div>

        <div
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
          const mark = st.px[x.sym] ?? x.entry;
          const pnl = posPnl(x, mark);
          const pct = (pnl / ((x.qty * x.entry) / x.lev)) * 100;
          const pnlColor = pnl >= 0 ? "#2fd18c" : "#ff6b57";
          const selected = x.id === st.sel;
          const extra = x.borrowed
            ? "BORROWED " + kmoney(x.borrowed)
            : x.listed
              ? "LISTED " + kmoney(x.listed)
              : x.buyin
                ? x.buyin + "% BUY-IN"
                : "";

          return (
            <div
              key={x.id}
              onClick={() => setSt((s) => ({ ...s, sel: x.id }))}
              style={{
                display: "grid",
                gap: 8,
                padding: "12px 12px",
                alignItems: "center",
                gridTemplateColumns: COLS,
                cursor: "pointer",
                borderBottom: "1px solid rgba(213,198,255,0.16)",
                borderLeft: `2px solid ${selected ? "#ffb765" : "transparent"}`,
                background: selected ? "rgba(150,112,255,0.12)" : "transparent",
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
                  {x.qty.toFixed(x.sym === "ETH" ? 2 : 1)} {x.sym}
                </div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: "#c3b8e3", ...CLIP }}>{money(x.entry, 2)}</div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <div style={{ fontFamily: MONO, fontSize: 12.5, color: "#e3ddf4", ...CLIP }}>{money(mark, 2)}</div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: "#ffb765", ...CLIP }}>
                  {money(liqOf(mark, x.side, x.lev), 0)}
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, overflow: "hidden" }}>
                <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", color: pnlColor }}>
                  {(pnl >= 0 ? "+" : "−") + money(Math.abs(pnl), 0).slice(1)}
                </div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: pnlColor }}>
                  {(pct >= 0 ? "+" : "−") + Math.abs(pct).toFixed(1)}%
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", minWidth: 0, overflow: "hidden" }}>
                <div
                  style={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    padding: "5px 8px",
                    borderRadius: 99,
                    whiteSpace: "nowrap",
                    background: x.tokenized ? "rgba(150,112,255,0.3)" : "rgba(255,255,255,0.08)",
                    color: x.tokenized ? "#d5c6ff" : "#a79bd0",
                  }}
                >
                  {x.tokenized ? "TOKENIZED" : "NOT MINTED"}
                </div>
                {extra && (
                  <div
                    style={{
                      fontSize: 9.5,
                      fontWeight: 700,
                      letterSpacing: "0.06em",
                      padding: "5px 8px",
                      borderRadius: 99,
                      whiteSpace: "nowrap",
                      background: "rgba(255,183,101,0.16)",
                      color: "#ffd9a0",
                    }}
                  >
                    {extra}
                  </div>
                )}
                {!x.tokenized && (
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      actions.mintPos(x.id);
                    }}
                    className="laxu-tokenize"
                    style={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      letterSpacing: "0.02em",
                      padding: "7px 13px",
                      borderRadius: 99,
                      whiteSpace: "nowrap",
                      cursor: "pointer",
                      color: "#fdfbf7",
                      background: "#9670ff",
                      boxShadow: "0 6px 16px rgba(150,112,255,0.42)",
                    }}
                  >
                    Tokenize
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {st.positions.length === 0 && (
          <div style={{ padding: "30px 16px", textAlign: "center", fontSize: 13, fontWeight: 500, color: "#d5c6ff" }}>
            No open positions. Place an order to get one.
          </div>
        )}

        {st.mintFor != null && <MintModal engine={engine} />}
      </div>
    </div>
  );
}
