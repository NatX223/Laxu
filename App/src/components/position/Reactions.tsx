"use client";

import { MONO, Panel, PanelHead } from "./shared";
import type { PositionEngine } from "./engine";

/** Emoji reactions from holders and watchers, with the picker underneath. */
export default function Reactions({ engine }: { engine: PositionEngine }) {
  const { vals, palette, toggleReact, addReact, togglePicker } = engine;

  return (
    <Panel>
      <PanelHead label="REACTIONS">
        <div style={{ fontSize: 11, fontWeight: 600, color: "#a79bd0" }}>
          {vals.reactionTotal} from holders and watchers
        </div>
      </PanelHead>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "14px 16px" }}>
        {vals.reactions.map((r, i) => (
          <button
            key={r.emoji}
            type="button"
            onClick={() => toggleReact(i)}
            title={r.who}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "7px 13px",
              borderRadius: 99,
              cursor: "pointer",
              border: `1px solid ${r.border}`,
              background: r.bg,
            }}
          >
            <span style={{ fontSize: 15, lineHeight: 1 }}>{r.emoji}</span>
            <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, color: r.ink }}>{r.count}</span>
          </button>
        ))}

        <button
          type="button"
          className="laxu-react-add"
          onClick={togglePicker}
          aria-expanded={vals.pickerOpen}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 13px",
            borderRadius: 99,
            cursor: "pointer",
            border: "1px dashed rgba(255,255,255,0.28)",
            background: "rgba(255,255,255,0.04)",
            color: "#a79bd0",
            fontFamily: "inherit",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          React
        </button>
      </div>

      {vals.pickerOpen && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", padding: "0 16px 14px" }}>
          {palette.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="laxu-react-swatch"
              onClick={() => addReact(emoji)}
              aria-label={`React with ${emoji}`}
              style={{
                width: 36,
                height: 36,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 17,
                borderRadius: 11,
                cursor: "pointer",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}
