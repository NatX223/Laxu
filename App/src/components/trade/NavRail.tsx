"use client";

import type { TradeEngine } from "./engine";
import type { View } from "./engine";

const ICONS: Record<View, React.ReactNode> = {
  trade: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
      <line x1="7" y1="4" x2="7" y2="20" />
      <rect x="4" y="8" width="6" height="8" rx="1.4" />
      <line x1="17" y1="4" x2="17" y2="20" />
      <rect x="14" y="11" width="6" height="7" rx="1.4" />
    </svg>
  ),
  tokens: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="9" r="5.2" />
      <path d="M14.5 5.2a5.2 5.2 0 0 1 0 13.6" />
      <path d="M6 15.5a5.2 5.2 0 0 0 9 3.3" />
    </svg>
  ),
  portfolio: (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="18" height="13" rx="2.4" />
      <path d="M8.5 7V5.6A1.6 1.6 0 0 1 10.1 4h3.8A1.6 1.6 0 0 1 15.5 5.6V7" />
    </svg>
  ),
};

const TITLES: Record<View, string> = { trade: "Trade", tokens: "Position tokens", portfolio: "Portfolio" };

/** 46px icon rail: the three views, with a mint count on the tokens tab. */
export default function NavRail({ engine }: { engine: TradeEngine }) {
  const { st, set } = engine;
  const minted = st.positions.filter((p) => p.tokenized).length;

  return (
    <div
      style={{
        flex: "none",
        width: 46,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "8px 0",
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 16,
        alignItems: "center",
      }}
    >
      {(Object.keys(ICONS) as View[]).map((view) => {
        const active = st.view === view;
        return (
          <div
            key={view}
            onClick={() => set("view", view)}
            title={TITLES[view]}
            style={{
              position: "relative",
              width: 36,
              height: 36,
              borderRadius: 11,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              transition: "background 0.2s ease",
              background: active ? "#9670ff" : "rgba(255,255,255,0.06)",
              color: active ? "#fdfbf7" : "#a79bd0",
            }}
          >
            {ICONS[view]}
            {view === "tokens" && (
              <div
                style={{
                  position: "absolute",
                  top: 4,
                  right: 3,
                  minWidth: 15,
                  height: 15,
                  borderRadius: 99,
                  background: "#ffb765",
                  color: "#16130f",
                  fontSize: 9,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "0 3px",
                }}
              >
                {minted}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ flex: 1 }} />
      <div style={{ width: 30, height: 1, background: "rgba(255,255,255,0.14)" }} />
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: "0.1em",
          color: "#7b719e",
          writingMode: "vertical-rl",
          padding: "10px 0",
        }}
      >
        ARCUS
      </div>
    </div>
  );
}
