"use client";

import { useAsset } from "@/lib/asset";
import { cat, money } from "./data";
import AccountMenu from "../auth/AccountMenu";
import FaucetButton from "../faucet/FaucetButton";
import MarketMenu from "./MarketMenu";
import type { TradeEngine } from "./engine";
import { Disc, MONO, SERIF } from "./shared";

/** Wordmark, market switcher, info toggle, wallet balance readout and account menu. */
export default function TopBar({ engine }: { engine: TradeEngine }) {
  const { st, set, infoShown, balances } = engine;

  // The wallet's live balance of the asset: what a new trade can draw on.
  const { symbol } = useAsset();
  const equity = balances.asset === null ? "—" : money(balances.asset, 2);

  return (
    <div
      className="laxu-topbar"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 18,
        padding: "0 16px",
        height: 58,
        background: "linear-gradient(90deg, #2f2459 0%, #261e49 62%, #221a42 100%)",
        borderBottom: "1px solid rgba(255,255,255,0.12)",
      }}
    >
      <div className="laxu-topbar-left" style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <div
          style={{
            fontFamily: SERIF,
            fontStyle: "italic",
            fontSize: 27,
            lineHeight: 1,
            letterSpacing: "-0.02em",
            color: "#fdfbf7",
          }}
        >
          Laxu
        </div>

        <div className="laxu-topbar-mkt" style={{ position: "relative", minWidth: 0 }}>
          <div
            onClick={() => set("mktMenu", !st.mktMenu)}
            className="laxu-mkt-pill"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              background: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: 99,
              padding: "5px 13px 5px 5px",
              cursor: "pointer",
              transition: "background 0.2s ease",
            }}
          >
            <Disc sym={st.market} size={26} font={12} />
            <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.04em", color: "#fdfbf7", whiteSpace: "nowrap", lineHeight: 1.1 }}>
                {st.market}-PERP
              </div>
              <div
                style={{
                  maxWidth: 150,
                  fontSize: 10.5,
                  fontWeight: 500,
                  color: "#a79bd0",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  lineHeight: 1.1,
                }}
              >
                {cat(st.market).name}
              </div>
            </div>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#a79bd0"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transform: `rotate(${st.mktMenu ? "180deg" : "0deg"})` }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
          {st.mktMenu && <MarketMenu engine={engine} />}
        </div>

        <div
          onClick={() => set("infoOpen", !st.infoOpen)}
          className="laxu-info-btn laxu-topbar-info"
          title={infoShown ? "Hide market info" : "Market info"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            fontWeight: 600,
            color: "#e3ddf4",
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.12)",
            padding: "7px 13px",
            borderRadius: 99,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="11" x2="12" y2="16" />
            <line x1="12" y1="8" x2="12" y2="8" />
          </svg>
          <span className="laxu-info-label">{infoShown ? "Hide market info" : "Market info"}</span>
        </div>
      </div>

      <div className="laxu-topbar-right" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1, padding: "0 6px" }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: "#a79bd0" }}>{symbol}</div>
          <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, color: "#fdfbf7" }}>{equity}</div>
        </div>
        <FaucetButton tone="amber" />
        <AccountMenu tone="amber" />
      </div>
    </div>
  );
}
