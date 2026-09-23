"use client";

import { Grain } from "../landing/shared";
import FilterBar from "./FilterBar";
import HeroBand from "./HeroBand";
import SpotlightCard from "./SpotlightCard";
import TokenTable from "./TokenTable";
import TradingViewCredit from "../charts/TradingViewCredit";
import TopNav from "./TopNav";
import { useCommunityEngine, type CommunityProps } from "./engine";
import { SERIF } from "./shared";

/**
 * The community market, transcribed from `Laxu Community.dc.html`.
 * Hero band over the top performers, then the sortable table of every other
 * minted position.
 *
 * `rowsPerPage`, `spotlightCount` and `liveTicker` are the knobs the
 * prototype exposed.
 */
export default function CommunityScreen(props: CommunityProps) {
  const engine = useCommunityEngine(props);
  const { st, vals, buy } = engine;

  return (
    <div
      className="laxu-community-root"
      style={{ position: "relative", minHeight: "100vh", background: "#1c1638", color: "#fdfbf7" }}
    >
      {/* one element, as in the design: z-index 8, 22% opacity, overlay blend */}
      <Grain zIndex={8} />

      <TopNav />
      <HeroBand vals={vals} />

      <div
        style={{
          position: "relative",
          zIndex: 2,
          maxWidth: 1320,
          margin: "0 auto",
          padding: "34px 28px 70px",
          display: "flex",
          flexDirection: "column",
          gap: 34,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontFamily: SERIF, fontSize: 30, lineHeight: 1, color: "#fdfbf7" }}>Top performers</div>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "#a79bd0" }}>
              ranked by 24h return &middot; updated live
            </div>
          </div>
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
            {vals.spotlight.map((t) => (
              <SpotlightCard key={t.sym} t={t} onBuy={() => buy(t.token)} />
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <FilterBar engine={engine} />
          <TokenTable engine={engine} />
        </div>

        {/* the sparklines hide their per-chart logo; this is their attribution */}
        <TradingViewCredit />
      </div>

      {st.toast && (
        <div
          className="laxu-toast"
          role="status"
          style={{
            position: "fixed",
            zIndex: 40,
            left: "50%",
            bottom: 28,
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 20px",
            borderRadius: 99,
            background: "rgba(36,28,70,0.9)",
            border: "1px solid rgba(255,255,255,0.18)",
            backdropFilter: "blur(18px)",
            boxShadow: "0 18px 40px rgba(10,6,28,0.5)",
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#5fe3a8" }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "#fdfbf7" }}>{st.toast}</span>
        </div>
      )}
    </div>
  );
}
