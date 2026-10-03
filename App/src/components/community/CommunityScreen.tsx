"use client";

import { Grain } from "../landing/shared";
import FilterBar from "./FilterBar";
import HeroBand from "./HeroBand";
import SpotlightCard from "./SpotlightCard";
import TokenTable from "./TokenTable";
import TradingViewCredit from "../charts/TradingViewCredit";
import Link from "next/link";
import TopNav from "./TopNav";
import { useCommunityEngine, type CommunityProps, type LoadState } from "./engine";
import { SERIF } from "./shared";

/**
 * The community market, transcribed from `Laxu Community.dc.html`.
 * Hero band over the top performers, then the sortable table of every other
 * listed position, all read from `GET /positions` and `GET /stats`.
 *
 * `rowsPerPage`, `spotlightCount` and `liveTicker` are the knobs the
 * prototype exposed.
 */
export default function CommunityScreen(props: CommunityProps) {
  const engine = useCommunityEngine(props);
  const { load, vals, buy } = engine;

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
          padding: "34px clamp(16px, 4vw, 28px) 70px",
          display: "flex",
          flexDirection: "column",
          gap: 34,
        }}
      >
        {vals.none ? (
          <EmptyMarket load={load} />
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                <div style={{ fontFamily: SERIF, fontSize: 30, lineHeight: 1, color: "#fdfbf7" }}>Top performers</div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "#a79bd0" }}>
                  ranked by PnL since entry &middot; refreshed every 30s
                </div>
              </div>
              <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))" }}>
                {vals.spotlight.map((t) => (
                  <SpotlightCard key={t.token.address} t={t} onBuy={() => buy(t.token)} />
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <FilterBar engine={engine} />
              <TokenTable engine={engine} />
            </div>
          </>
        )}

        {/* the sparklines hide their per-chart logo; this is their attribution */}
        <TradingViewCredit />
      </div>
    </div>
  );
}

/** No listed positions to show: still loading, the backend unreachable, or genuinely none yet. */
function EmptyMarket({ load }: { load: LoadState }) {
  const [title, body] =
    load === "loading"
      ? ["Loading the market…", "Fetching every listed position token."]
      : load === "error"
        ? ["Couldn’t reach the market", "The Laxu backend didn’t answer. It will retry on its own every 30 seconds."]
        : ["No listed position tokens yet", "Open a position from Trade and list it, and it shows up here for anyone to buy into."];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        padding: "64px 20px",
        textAlign: "center",
        borderRadius: 18,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(255,255,255,0.04)",
      }}
    >
      <div style={{ fontFamily: SERIF, fontSize: 28, lineHeight: 1.1, color: "#fdfbf7" }}>{title}</div>
      <div style={{ maxWidth: 440, fontSize: 13.5, lineHeight: 1.6, fontWeight: 500, color: "#a79bd0" }}>{body}</div>
      {load === "ready" && (
        <Link
          href="/trade"
          style={{
            marginTop: 6,
            fontSize: 12.5,
            fontWeight: 700,
            color: "#fdfbf7",
            background: "#9670ff",
            padding: "9px 18px",
            borderRadius: 99,
          }}
        >
          Open a position
        </Link>
      )}
    </div>
  );
}
