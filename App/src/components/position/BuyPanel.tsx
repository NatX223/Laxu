"use client";

import { CELL_BG, HAIRLINE, MONO, Panel, SERIF } from "./shared";
import type { PositionEngine } from "./engine";

/** The buy-in ticket: amount, the quote it produces, and the mint button. */
export default function BuyPanel({ engine }: { engine: PositionEngine }) {
  const { vals, setAmount, buy } = engine;

  return (
    <Panel
      style={{
        border: "1px solid rgba(255,255,255,0.16)",
        background: "rgba(255,255,255,0.055)",
        backdropFilter: "blur(18px)",
        boxShadow: "0 24px 48px rgba(10,6,28,0.4)",
      }}
    >
      <div
        style={{
          padding: "14px 16px",
          background: "linear-gradient(90deg, rgba(150,112,255,0.34), rgba(255,183,101,0.14))",
          borderBottom: "1px solid rgba(255,255,255,0.12)",
        }}
      >
        <div style={{ fontFamily: SERIF, fontSize: 22, lineHeight: 1.1, color: "#fdfbf7" }}>
          Buy into this position
        </div>
        <div style={{ fontSize: 11.5, fontWeight: 500, color: "#d5c6ff", paddingTop: 3 }}>{vals.buyinHint}</div>
      </div>

      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 13 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <label
              htmlFor="laxu-buyin"
              style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" }}
            >
              AMOUNT
            </label>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#8f85bd" }}>balance {vals.balance}</div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "11px 14px",
              borderRadius: 12,
              background: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.18)",
            }}
          >
            <span style={{ fontFamily: MONO, fontSize: 16, color: "#a79bd0" }}>$</span>
            <input
              id="laxu-buyin"
              value={vals.amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              style={{
                flex: 1,
                minWidth: 0,
                background: "transparent",
                border: "none",
                outline: "none",
                color: "#fdfbf7",
                fontFamily: MONO,
                fontSize: 17,
                fontWeight: 600,
              }}
            />
            <span style={{ fontSize: 11.5, fontWeight: 700, color: "#a79bd0" }}>USDG</span>
          </div>

          <div style={{ display: "flex", gap: 6 }}>
            {vals.quickAmounts.map((q) => (
              <button
                key={q.label}
                type="button"
                className="laxu-quick"
                onClick={() => setAmount(q.value)}
                style={{
                  flex: 1,
                  textAlign: "center",
                  fontFamily: "inherit",
                  fontSize: 11.5,
                  fontWeight: 700,
                  padding: "7px 0",
                  borderRadius: 99,
                  cursor: "pointer",
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.14)",
                  color: "#c2b6e4",
                }}
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 1,
            borderRadius: 12,
            overflow: "hidden",
            background: HAIRLINE,
          }}
        >
          {vals.quote.map((q) => (
            <div
              key={q.k}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "10px 13px",
                background: CELL_BG,
              }}
            >
              <div style={{ fontSize: 11.5, fontWeight: 600, color: "#a79bd0" }}>{q.k}</div>
              <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color: q.c }}>{q.v}</div>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="laxu-buy"
          onClick={buy}
          disabled={vals.buyDisabled}
          style={{
            textAlign: "center",
            fontFamily: "inherit",
            fontSize: 13,
            fontWeight: 700,
            padding: 13,
            border: "none",
            borderRadius: 99,
            cursor: vals.buyDisabled ? "default" : "pointer",
            color: vals.buyInk,
            background: vals.buyBg,
            boxShadow: "0 10px 26px rgba(150,112,255,0.36)",
          }}
        >
          {vals.buyLabel}
        </button>

        <div style={{ fontSize: 10.5, fontWeight: 500, lineHeight: 1.5, color: "#8f85bd", textWrap: "pretty" }}>
          Buy-ins mint new token supply against the same position. Your share dilutes only if the creator opens more
          allocation.
        </div>
      </div>
    </Panel>
  );
}
