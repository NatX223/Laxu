"use client";

import { useAsset } from "@/lib/asset";
import { cat } from "./data";
import type { TradeEngine } from "./engine";
import { Disc, MONO, SERIF } from "./shared";
import { statsFor, useStatsInputs } from "./stats";

/**
 * Collapsible 214px market dossier. The outer wrapper animates its width to 0
 * rather than unmounting, so the panel slides instead of popping.
 */
export default function InfoPanel({ engine }: { engine: TradeEngine }) {
  const { st, set, infoShown } = engine;
  const m = cat(st.market);
  const { symbol } = useAsset();
  const stats = statsFor(m.live, useStatsInputs(), 0);

  // Perpl's own figures for the market; a dash while it hasn't loaded.
  const facts = [
    { k: "MAX LEVERAGE", v: m.live ? `${m.lev}×` : "—" },
    { k: "MIN SIZE", v: m.live ? `${(10 ** -m.live.sizeDecimals).toFixed(m.live.sizeDecimals)} ${m.live.baseAsset}` : "—" },
    { k: "TAKER FEE", v: m.live ? `${(m.live.takerFee * 100).toFixed(4).replace(/0+$/, "").replace(/.$/, "")}%` : "—" },
    { k: "FUNDING", v: m.live ? `every ${stats.fundingInterval.toLowerCase()}` : "—" },
    { k: "SETTLES", v: symbol },
  ];

  return (
    <div
      className={infoShown ? "laxu-info-panel is-open" : "laxu-info-panel"}
      style={{
        flex: "none",
        minWidth: 0,
        overflow: "hidden",
        transition: "width 0.34s cubic-bezier(0.4,0,0.2,1), opacity 0.28s ease",
        width: infoShown ? 214 : 0,
        opacity: infoShown ? 1 : 0,
      }}
    >
      <div
        className="laxu-info-inner"
        style={{
          width: 214,
          height: "100%",
          background: "rgba(255,255,255,0.045)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 16,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            padding: "14px 14px 12px",
            borderBottom: "1px solid rgba(255,255,255,0.1)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <Disc sym={st.market} size={30} font={13} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#fdfbf7", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {m.name}
              </div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "#a79bd0" }}>{m.kind}</div>
            </div>
          </div>
          <div
            onClick={() => set("infoOpen", !st.infoOpen)}
            className="laxu-info-close"
            style={{
              flex: "none",
              width: 24,
              height: 24,
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: "#a79bd0",
              background: "rgba(255,255,255,0.06)",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 6 9 12 15 18" />
            </svg>
          </div>
        </div>

        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
          <div style={{ fontSize: 12.5, lineHeight: 1.6, fontWeight: 500, color: "#e3ddf4", textWrap: "pretty" }}>
            Perpetual on {m.name}, settled in {symbol} and traded around the clock on Perpl. Funding follows the {m.noun} price
            and applies every {stats.fundingInterval.toLowerCase()}.
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 1,
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            {facts.map((f) => (
              <div
                key={f.k}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "10px 12px",
                  background: "#241c46",
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "#a79bd0" }}>{f.k}</div>
                <div style={{ fontFamily: MONO, fontSize: 12, fontWeight: 500, color: "#fdfbf7" }}>{f.v}</div>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: "#a79bd0" }}>TOKENIZED ON LAXU</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <div style={{ fontFamily: SERIF, fontSize: 30, lineHeight: 1, color: "#fdfbf7" }}>{stats.tokens}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#a79bd0" }}>open position tokens</div>
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.55, fontWeight: 500, color: "#c3b8e3" }}>
              Borrow against any {st.market} position token at a flat 10% APR, from its own isolated pool.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
