import { CELL_BG, HAIRLINE, MONO, Panel } from "./shared";
import type { Holder } from "./derive";

/** Who holds the token, and how much of the position that is. */
export default function HolderBase({ holders }: { holders: Holder[] }) {
  return (
    <Panel>
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.1)",
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: "0.14em",
          color: "#c3b8e3",
        }}
      >
        HOLDER BASE
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 1, background: HAIRLINE }}>
        {holders.map((h) => (
          <div
            key={h.name}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", background: CELL_BG }}
          >
            <div style={{ flex: "none", width: 24, height: 24, borderRadius: "50%", background: h.tint }} />
            <div
              style={{
                flex: 1,
                minWidth: 0,
                fontFamily: MONO,
                fontSize: 11.5,
                color: "#c2b6e4",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {h.name}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 11.5, fontWeight: 600, color: "#fdfbf7" }}>{h.share}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
