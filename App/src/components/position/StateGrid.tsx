import { CELL_BG, HAIRLINE, MONO, Panel, PanelHead } from "./shared";
import type { PositionVals } from "./derive";

/**
 * The eight-cell readout of where the position actually stands.
 *
 * The design's `auto-fit` tracks fit five across at this column width, which
 * leaves a ragged 5 + 3; the count is pinned to four so the two rows balance.
 * `laxu-state-grid` carries the tracks and the narrow-screen fallback.
 */
export default function StateGrid({ vals }: { vals: PositionVals }) {
  return (
    <Panel>
      <PanelHead label="POSITION STATE">
        <div style={{ fontSize: 11, fontWeight: 600, color: "#a79bd0" }}>last oracle report {vals.lastReport}</div>
      </PanelHead>
      <div className="laxu-state-grid" style={{ display: "grid", gap: 1, background: HAIRLINE }}>
        {vals.stats.map((c) => (
          <div
            key={c.k}
            style={{ padding: "13px 16px", background: CELL_BG, display: "flex", flexDirection: "column", gap: 4 }}
          >
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em", color: "#a79bd0" }}>{c.k}</div>
            <div style={{ fontFamily: MONO, fontSize: 16, fontWeight: 500, color: c.c }}>{c.v}</div>
            {c.sub && <div style={{ fontSize: 10.5, fontWeight: 500, color: "#8f85bd" }}>{c.sub}</div>}
          </div>
        ))}
      </div>
    </Panel>
  );
}
