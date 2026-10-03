"use client";

import { Grain } from "../landing/shared";
import BookPanel from "./BookPanel";
import Chart from "./Chart";
import InfoPanel from "./InfoPanel";
import NavRail from "./NavRail";
import OpenProgress from "./OpenProgress";
import OrderTicket from "./OrderTicket";
import PortfolioView from "./PortfolioView";
import PositionsDock from "./PositionsDock";
import StatsBar from "./StatsBar";
import TokensView from "./TokensView";
import TopBar from "./TopBar";
import { deriveMarket } from "./derive";
import { useTradeEngine } from "./engine";

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

        <div className="laxu-trade-main" style={{ display: "flex", alignItems: "stretch", gap: 8, padding: 8 }}>
          <NavRail engine={engine} />
          <InfoPanel engine={engine} />

          <div className="laxu-trade-center" style={{ flex: "1 1 380px", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            <StatsBar engine={engine} mkt={mkt} />

            {isTrade && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <Chart engine={engine} mkt={mkt} />
              </div>
            )}

            {st.view === "tokens" && <TokensView engine={engine} />}

            {st.view === "portfolio" && <PortfolioView />}
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

      <OpenProgress open={engine.open} />
    </div>
  );
}
