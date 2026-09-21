"use client";

import type { CommunityEngine } from "./engine";

/** Sort chips on the left, asset-kind chips and the search field on the right. */
export default function FilterBar({ engine }: { engine: CommunityEngine }) {
  const { vals, st, setSort, setKind, setQuery } = engine;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
        padding: "12px 14px",
        borderRadius: 16,
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.12)",
        backdropFilter: "blur(14px)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0", paddingRight: 4 }}>
          SORT
        </div>
        {vals.sorts.map((s) => (
          <div
            key={s.key}
            onClick={() => setSort(s.key)}
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: "8px 14px",
              borderRadius: 99,
              cursor: "pointer",
              whiteSpace: "nowrap",
              border: `1px solid ${s.border}`,
              background: s.bg,
              color: s.ink,
            }}
          >
            {s.label}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {vals.kinds.map((k) => (
          <div
            key={k.key}
            onClick={() => setKind(k.key)}
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              padding: "7px 13px",
              borderRadius: 99,
              cursor: "pointer",
              whiteSpace: "nowrap",
              border: `1px solid ${k.border}`,
              background: k.bg,
              color: k.ink,
            }}
          >
            {k.label}
          </div>
        ))}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 12px",
            height: 34,
            borderRadius: 99,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.14)",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a79bd0" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
          <input
            value={st.query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search token or minter"
            aria-label="Search token or minter"
            style={{
              width: 190,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "#fdfbf7",
              fontFamily: "var(--font-archivo), sans-serif",
              fontSize: 12.5,
            }}
          />
        </div>
      </div>
    </div>
  );
}
