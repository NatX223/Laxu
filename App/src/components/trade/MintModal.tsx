"use client";

import { money } from "./data";
import { aliasTicker, defaultAlias, posEquity, type TradeEngine } from "./engine";
import { Disc, MONO, SERIF } from "./shared";

/** Name-your-token sheet, opened from a position row's Tokenize button. */
export default function MintModal({ engine }: { engine: TradeEngine }) {
  const { st, setSt, actions } = engine;
  const p = st.positions.find((x) => x.id === st.mintFor);
  if (!p) return null;

  const mark = st.px[p.sym] ?? p.entry;

  return (
    <div
      onClick={actions.closeMint}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "rgba(14,10,32,0.62)",
        backdropFilter: "blur(10px)",
        animation: "laxu-fade 0.16s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 420,
          borderRadius: 20,
          overflow: "hidden",
          background: "rgba(36,28,70,0.92)",
          border: "1px solid rgba(255,255,255,0.18)",
          backdropFilter: "blur(26px)",
          boxShadow: "0 30px 70px rgba(8,5,24,0.6)",
          animation: "laxu-rise 0.2s ease",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "16px 18px",
            background: "linear-gradient(90deg, rgba(150,112,255,0.4), rgba(255,183,101,0.16))",
            borderBottom: "1px solid rgba(255,255,255,0.12)",
          }}
        >
          <Disc sym={p.sym} size={30} font={13} />
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <div style={{ fontFamily: SERIF, fontSize: 20, lineHeight: 1.1, color: "#fdfbf7" }}>Name your token</div>
            <div style={{ fontSize: 11.5, fontWeight: 500, color: "#d5c6ff" }}>
              {`${p.sym} ${p.side}, ${p.lev}×`} &middot; {money(posEquity(p, mark), 0)} equity &middot; entry {money(p.entry, 2)}
            </div>
          </div>
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" }}>TOKEN NAME</div>
            <input
              value={st.mintName}
              onChange={(e) => setSt((s) => ({ ...s, mintName: e.target.value.slice(0, 28) }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") actions.confirmMint();
                if (e.key === "Escape") actions.closeMint();
              }}
              placeholder={defaultAlias(p)}
              autoFocus
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "12px 14px",
                borderRadius: 12,
                background: "rgba(255,255,255,0.07)",
                border: "1px solid rgba(255,255,255,0.18)",
                outline: "none",
                color: "#fdfbf7",
                fontFamily: "inherit",
                fontSize: 15,
                fontWeight: 600,
              }}
            />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div style={{ fontSize: 11.5, fontWeight: 500, color: "#a79bd0" }}>Shown wherever this position trades.</div>
              <div style={{ fontFamily: MONO, fontSize: 11.5, color: "#ffd9a0" }}>{aliasTicker(p, st.mintName)}</div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 9 }}>
            <div
              onClick={actions.closeMint}
              className="laxu-mint-cancel"
              style={{
                flex: "none",
                fontSize: 12.5,
                fontWeight: 700,
                padding: "11px 18px",
                borderRadius: 99,
                cursor: "pointer",
                color: "#d5c6ff",
                border: "1px solid rgba(255,255,255,0.18)",
                background: "rgba(255,255,255,0.05)",
              }}
            >
              Cancel
            </div>
            <div
              onClick={actions.confirmMint}
              className="laxu-tokenize"
              style={{
                flex: 1,
                textAlign: "center",
                fontSize: 12.5,
                fontWeight: 700,
                padding: "11px 18px",
                borderRadius: 99,
                cursor: "pointer",
                color: "#fdfbf7",
                background: "#9670ff",
                boxShadow: "0 8px 22px rgba(150,112,255,0.42)",
              }}
            >
              Mint position token
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
