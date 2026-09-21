"use client";

import { Grain } from "../landing/shared";
import TopNav from "../community/TopNav";
import BuyPanel from "./BuyPanel";
import HolderBase from "./HolderBase";
import LeverageView from "./LeverageView";
import PositionHeader from "./PositionHeader";
import Reactions from "./Reactions";
import StateGrid from "./StateGrid";
import { usePositionEngine, type PositionProps } from "./engine";

/**
 * A single position token, transcribed from `Laxu Position.dc.html`.
 * Identity band, then the state grid and the two-chart leverage view over a
 * sticky buy-in ticket.
 *
 * `nickname`, `status`, `side`, `leverage`, `creatorFeeBps` and
 * `collateralized` are the knobs the prototype exposed.
 */
export default function PositionScreen(props: PositionProps) {
  const engine = usePositionEngine(props);
  const { st, vals } = engine;

  return (
    <div
      className="laxu-position-root"
      style={{ position: "relative", minHeight: "100vh", background: "#1c1638", color: "#fdfbf7" }}
    >
      {/* one element, as in the design: z-index 8, 22% opacity, overlay blend */}
      <Grain zIndex={8} />

      <TopNav communityHref="/community" />
      <PositionHeader vals={vals} />

      <div
        style={{
          position: "relative",
          zIndex: 2,
          maxWidth: 1280,
          margin: "0 auto",
          padding: "26px 28px 70px",
          display: "grid",
          gap: 20,
          gridTemplateColumns: "minmax(0, 1fr) 340px",
          alignItems: "start",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
          <StateGrid vals={vals} />
          <LeverageView engine={engine} />
          <Reactions engine={engine} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16, position: "sticky", top: 18 }}>
          <BuyPanel engine={engine} />
          <HolderBase holders={vals.holdersList} />
        </div>
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
            background: "rgba(36,28,70,0.92)",
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
