"use client";

import { Grain } from "../landing/shared";
import BookPanel from "./BookPanel";
import Chart from "./Chart";
import InfoPanel from "./InfoPanel";
import NavRail from "./NavRail";
import OrderTicket from "./OrderTicket";
import PositionsDock from "./PositionsDock";
import StatsBar from "./StatsBar";
import TokensView from "./TokensView";
import TopBar from "./TopBar";
import { deriveMarket } from "./derive";
import { useTradeEngine } from "./engine";
import { SERIF } from "./shared";

/**
 * The trade workspace, transcribed from `Laxu Trade.dc.html`.
 * Three columns — chart, book, ticket — over the positions dock, with the
 * grain wash the rest of the site uses laid across the whole screen.
 *
 * `showDepth` and `liveTicks` are the two knobs the prototype exposed.
 */
export default function TradeScreen({
  showDepth = true,
  liveTicks = true,
}: {
  showDepth?: boolean;
  liveTicks?: boolean;
}) {
  const engine = useTradeEngine(liveTicks);
  const { st, hostRef } = engine;
  const mkt = deriveMarket(st);
  const isTrade = st.view === "trade";

  return (
    <div
      className="laxu-trade-root"
      style={{ position: "relative", minHeight: "100vh", background: "#1c1638", color: "#fdfbf7" }}
    >
      {/* one element, as in the design: z-index 6, 22% opacity, overlay blend */}
      <Grain zIndex={6} />

      <div ref={hostRef} style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
        <TopBar engine={engine} />

        <div style={{ display: "flex", alignItems: "stretch", gap: 8, padding: 8 }}>
          <NavRail engine={engine} />
          <InfoPanel engine={engine} />

          <div style={{ flex: "1 1 380px", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            <StatsBar engine={engine} mkt={mkt} />

            {isTrade && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <Chart engine={engine} mkt={mkt} />
              </div>
            )}

            {st.view === "tokens" && <TokensView engine={engine} />}

            {st.view === "portfolio" && (
              <div
                style={{
                  padding: "80px 20px",
                  textAlign: "center",
                  background: "rgba(255,255,255,0.045)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 16,
                }}
              >
                <div style={{ fontFamily: SERIF, fontSize: 34, color: "#fdfbf7" }}>Portfolio</div>
                <div style={{ fontSize: 14, fontWeight: 500, color: "#a79bd0", paddingTop: 8 }}>
                  Equity curve, realized P&amp;L and pool interest — next screen up.
                </div>
              </div>
            )}
          </div>

          {isTrade && (
            <>
              <BookPanel engine={engine} mkt={mkt} showDepth={showDepth} />
              <OrderTicket engine={engine} mkt={mkt} />
            </>
          )}
        </div>

        {isTrade && <PositionsDock engine={engine} />}
      </div>
    </div>
  );
}
