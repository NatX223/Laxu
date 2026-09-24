"use client";

import { useEffect, useRef } from "react";
import { useMarketRefresh } from "@/lib/markets";
import {
  MARKET_CATS,
  MARKET_TABS,
  cat,
  dpOf,
  money,
  syms,
} from "./data";
import type { TradeEngine } from "./engine";
import { Disc, MONO } from "./shared";

const COLS = "minmax(150px,1.35fr) minmax(0,1fr) minmax(0,1.75fr) minmax(0,0.8fr) minmax(0,0.8fr) minmax(0,0.85fr) minmax(0,0.9fr)";
const HEADS = ["Name", "Mark Price", "24h Change", "24h Laxu Vol.", "1h Funding", "Market Cap", "Open Interest"];

function Star({ filled, color }: { filled: boolean; color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" fill={filled ? color : "none"}>
      <polygon points="12 3 14.9 9 21.4 9.9 16.7 14.4 17.8 20.8 12 17.8 6.2 20.8 7.3 14.4 2.6 9.9 9.1 9" />
    </svg>
  );
}

/** The Ctrl+K market picker: a full-bleed blurred sheet over the whole app. */
export default function MarketMenu({ engine }: { engine: TradeEngine }) {
  const { st, set, actions } = engine;
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // The menu only mounts while open: refetch on open, then every 60s.
  useMarketRefresh(60_000);

  const q = st.mq.trim().toLowerCase();
  const rows = syms().filter((sym) => {
    const c = cat(sym);
    // "nvidia", "NVDA" and "nvda-usd" all find NVDA
    if (q && ![sym, c.displaySymbol, c.name].some((field) => field.toLowerCase().includes(q))) return false;
    if (st.mktTab === "Spot" && c.cat !== "Crypto" && c.cat !== "Equities") return false;
    if (st.mktCat === "★") return st.favs.includes(sym);
    if (st.mktCat !== "All") return c.cat === st.mktCat;
    return true;
  });

  const favActive = st.mktCat === "★";

  return (
    <div
      onClick={() => set("mktMenu", false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "78px 24px 24px",
        background: "rgba(14,10,30,0.62)",
        backdropFilter: "blur(22px) saturate(140%)",
        WebkitBackdropFilter: "blur(22px) saturate(140%)",
        animation: "laxu-fade 0.16s ease both",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 1180,
          maxHeight: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "rgba(36,28,70,0.78)",
          border: "1px solid rgba(255,255,255,0.14)",
          borderRadius: 22,
          boxShadow: "0 40px 90px rgba(0,0,0,0.6)",
          animation: "laxu-rise 0.2s ease both",
        }}
      >
        <div style={{ flex: "none", padding: "16px 18px 0" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "13px 16px",
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: 14,
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#a79bd0" strokeWidth="2.3" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="21" y2="21" />
            </svg>
            <input
              ref={searchRef}
              value={st.mq}
              onChange={(e) => set("mq", e.target.value)}
              placeholder="Search any perpetual market using name or ticker"
              style={{
                flex: 1,
                minWidth: 0,
                fontFamily: "inherit",
                fontSize: 15,
                fontWeight: 500,
                color: "#fdfbf7",
                background: "transparent",
                border: "none",
                outline: "none",
              }}
            />
          </div>
        </div>

        <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 22, padding: "14px 20px 0" }}>
          {MARKET_TABS.map((t) => (
            <div
              key={t}
              onClick={() => set("mktTab", t)}
              style={{
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: "0.01em",
                cursor: "pointer",
                paddingBottom: 9,
                borderBottom: `2px solid ${st.mktTab === t ? "#ffb765" : "transparent"}`,
                color: st.mktTab === t ? "#fdfbf7" : "#a79bd0",
              }}
            >
              {t}
            </div>
          ))}
          <div style={{ flex: 1, borderBottom: "1px solid rgba(255,255,255,0.1)", paddingBottom: 9 }} />
        </div>

        <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 7, padding: "14px 20px 12px", flexWrap: "wrap" }}>
          <div
            onClick={() => set("mktCat", favActive ? "All" : "★")}
            className="laxu-mkt-chip"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 34,
              height: 30,
              borderRadius: 9,
              cursor: "pointer",
              background: favActive ? "rgba(255,183,101,0.22)" : "transparent",
              color: favActive ? "#ffd9a0" : "#a79bd0",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
              <polygon points="12 3 14.9 9 21.4 9.9 16.7 14.4 17.8 20.8 12 17.8 6.2 20.8 7.3 14.4 2.6 9.9 9.1 9" />
            </svg>
          </div>
          {MARKET_CATS.map((c) => (
            <div
              key={c}
              onClick={() => set("mktCat", c)}
              className="laxu-mkt-chip"
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                padding: "7px 14px",
                borderRadius: 9,
                cursor: "pointer",
                whiteSpace: "nowrap",
                background: st.mktCat === c ? "rgba(255,255,255,0.14)" : "transparent",
                border: `1px solid ${st.mktCat === c ? "rgba(255,255,255,0.26)" : "rgba(255,255,255,0.09)"}`,
                color: st.mktCat === c ? "#fdfbf7" : "#a79bd0",
              }}
            >
              {c}
            </div>
          ))}
        </div>

        <div
          style={{
            flex: "none",
            display: "grid",
            gridTemplateColumns: COLS,
            gap: 10,
            padding: "10px 20px",
            borderTop: "1px solid rgba(255,255,255,0.09)",
            borderBottom: "1px solid rgba(255,255,255,0.09)",
          }}
        >
          {HEADS.map((h) => (
            <div key={h} style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", color: "#a79bd0" }}>
              {h}
            </div>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
          {rows.map((sym) => {
            const c = cat(sym);
            const price = st.px[sym] ?? c.base;
            // Arcus's own 24h change when live; the simulated series' otherwise.
            let chp: number;
            let delta: number;
            if (c.live) {
              chp = Number(c.live.priceChange24h) * 100;
              delta = price - price / (1 + chp / 100);
            } else {
              const list = st.candles[sym] || [];
              const open = list.length ? list[0].o : price;
              chp = open ? ((price - open) / open) * 100 : 0;
              delta = price - open;
            }
            const up = chp >= 0;
            const fav = st.favs.includes(sym);
            return (
              <div
                key={sym}
                onClick={() => actions.pickMarket(sym)}
                className="laxu-mkt-row"
                style={{
                  display: "grid",
                  alignItems: "center",
                  gridTemplateColumns: COLS,
                  gap: 10,
                  padding: "12px 20px",
                  cursor: "pointer",
                  borderBottom: "1px solid rgba(255,255,255,0.05)",
                  background: sym === st.market ? "rgba(150,112,255,0.18)" : "transparent",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, overflow: "hidden" }}>
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      actions.toggleFav(sym);
                    }}
                    style={{ flex: "none", display: "flex", padding: 2, cursor: "pointer", color: fav ? "#ffb765" : "#6f6788" }}
                  >
                    <Star filled={fav} color="#ffb765" />
                  </div>
                  <Disc sym={sym} size={24} font={11} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <div style={{ flex: "none", fontSize: 14, fontWeight: 700, color: "#fdfbf7", whiteSpace: "nowrap" }}>{sym}</div>
                      {st.mktTab !== "Spot" && (
                        <div
                          style={{
                            flex: "none",
                            fontFamily: MONO,
                            fontSize: 10.5,
                            fontWeight: 600,
                            color: "#d5c6ff",
                            background: "rgba(255,255,255,0.09)",
                            borderRadius: 6,
                            padding: "3px 6px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          Up to {c.lev}&times;
                        </div>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        fontWeight: 500,
                        color: "#a79bd0",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {c.name}
                    </div>
                  </div>
                </div>
                <div style={{ fontFamily: MONO, fontSize: 13, color: "#fdfbf7", whiteSpace: "nowrap" }}>{money(price, dpOf(sym))}</div>
                <div style={{ fontFamily: MONO, fontSize: 13, whiteSpace: "nowrap", color: up ? "#58e0a6" : "#ff8f7d" }}>
                  {(up ? "+" : "−") + "$" + money(Math.abs(delta), dpOf(sym)).slice(1) + " (" + (up ? "+" : "") + chp.toFixed(2) + "%)"}
                </div>
                <div style={{ fontFamily: MONO, fontSize: 13, color: "#e3ddf4" }}>{c.vol}</div>
                <div style={{ fontFamily: MONO, fontSize: 13, color: "#58e0a6" }}>{c.fund}</div>
                <div style={{ fontFamily: MONO, fontSize: 13, color: "#e3ddf4" }}>{c.mcap}</div>
                <div style={{ fontFamily: MONO, fontSize: 13, color: "#e3ddf4" }}>{c.oi}</div>
              </div>
            );
          })}
          {rows.length === 0 && (
            <div style={{ padding: "44px 20px", textAlign: "center", fontSize: 13, fontWeight: 600, color: "#a79bd0" }}>
              No market matches that search.
            </div>
          )}
        </div>

        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 20px",
            flexWrap: "wrap",
            borderTop: "1px solid rgba(255,255,255,0.09)",
            background: "rgba(0,0,0,0.18)",
          }}
        >
          {[
            ["Ctrl+K", "Open/Close"],
            ["Esc", "Close"],
            ["↵", "Select"],
          ].map(([key, label]) => (
            <ShortcutHint key={key} hint={key} label={label} />
          ))}
          <div style={{ flex: 1, minWidth: 10 }} />
          <div style={{ fontSize: 11.5, fontWeight: 600, color: "#a79bd0", whiteSpace: "nowrap" }}>{rows.length} markets</div>
        </div>
      </div>
    </div>
  );
}

function ShortcutHint({ hint, label }: { hint: string; label: string }) {
  return (
    <>
      <div
        style={{
          fontFamily: MONO,
          fontSize: 10.5,
          fontWeight: 600,
          color: "#d5c6ff",
          background: "rgba(255,255,255,0.08)",
          border: "1px solid rgba(255,255,255,0.14)",
          borderRadius: 7,
          padding: "4px 8px",
        }}
      >
        {hint}
      </div>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: "#a79bd0", paddingRight: 10 }}>{label}</div>
    </>
  );
}
