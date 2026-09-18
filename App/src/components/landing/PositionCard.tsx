"use client";

import { useCallback, useRef, useState } from "react";
import { COPY, type PositionCard as Card } from "./data";
import { SERIF } from "./shared";

const KNOB = 36;
const PAD = 3;

function Metric({ label, value, ink }: { label: string; value: string; ink: string }) {
  return (
    <div
      style={{
        padding: "12px 16px",
        background: "rgba(255,255,255,0.5)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 3,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.08em",
          color: "#6f6659",
        }}
      >
        {label}
      </div>
      <div style={{ fontFamily: SERIF, fontSize: 20, color: ink }}>{value}</div>
    </div>
  );
}

export default function PositionCard({ card }: { card: Card }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [x, setX] = useState(0);
  const [done, setDone] = useState(false);
  // the pointer handlers close over this, so reads stay current mid-drag
  const xRef = useRef(0);

  const commit = useCallback((next: number) => {
    xRef.current = next;
    setX(next);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // a settled slider acts as a reset button rather than a drag handle
      if (done) {
        commit(0);
        setDone(false);
        return;
      }

      e.preventDefault();
      const el = trackRef.current;
      if (!el) return;

      const max = el.offsetWidth - KNOB - PAD * 2;

      // the whole orbit is CSS-scaled, so client coordinates have to be
      // converted back into the track's own untransformed pixel space
      const at = (clientX: number) => {
        const r = el.getBoundingClientRect();
        const ratio = r.width ? el.offsetWidth / r.width : 1;
        return (clientX - r.left) * ratio - PAD;
      };

      const grab = at(e.clientX) - xRef.current;

      const move = (ev: PointerEvent) => {
        commit(Math.max(0, Math.min(max, at(ev.clientX) - grab)));
      };

      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (max > 0 && xRef.current >= max * COPY.slideThreshold) {
          commit(max);
          setDone(true);
        } else {
          commit(0);
        }
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [commit, done],
  );

  return (
    <div
      style={{
        transform: card.tilt,
        background: "rgba(253,251,247,0.74)",
        border: "1px solid rgba(255,255,255,0.8)",
        borderRadius: 18,
        overflow: "hidden",
        boxShadow: card.shadow,
        aspectRatio: "4 / 3",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 16px",
          background: card.headerBg,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 24,
              height: 24,
              background: card.markBg,
              borderRadius: card.markRadius,
            }}
          />
          <div style={{ fontFamily: SERIF, fontSize: 18, color: "#fdfbf7" }}>{card.title}</div>
        </div>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.08em",
            color: card.statusInk,
            background: card.statusBg,
            padding: "4px 8px",
            borderRadius: 99,
          }}
        >
          {card.status}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gridAutoRows: "1fr",
          gap: 1,
          background: "rgba(26,23,20,0.1)",
          flex: 1,
          minHeight: 0,
        }}
      >
        <Metric label="ENTRY" value={card.entry} ink="#1a1714" />
        <Metric label="MARK" value={card.mark} ink="#1a1714" />
        <Metric label="SIZE" value={card.size} ink="#1a1714" />
        <Metric label="UNREALIZED" value={card.unrealized} ink={card.unrealizedInk} />
      </div>

      <div style={{ padding: 12 }}>
        <div
          ref={trackRef}
          style={{
            position: "relative",
            height: 42,
            borderRadius: 99,
            background: "rgba(255,255,255,0.55)",
            border: "1px solid rgba(255,255,255,0.8)",
            boxShadow: "inset 0 2px 6px rgba(26,23,20,0.08)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              height: "100%",
              borderRadius: 99,
              background: card.fill,
              transition: "width 0.08s linear",
              width: x + 42,
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.16em",
              color: "#6f6659",
              pointerEvents: "none",
            }}
          >
            {done ? "TOKENIZED" : "SLIDE TO TOKENIZE"}
          </div>
          <div
            onPointerDown={onPointerDown}
            role="slider"
            tabIndex={0}
            aria-label={`Slide to tokenize ${card.title}`}
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={done ? 1 : 0}
            aria-valuetext={done ? "Tokenized" : "Not tokenized"}
            style={{
              position: "absolute",
              left: 3,
              top: 3,
              width: KNOB,
              height: KNOB,
              borderRadius: "50%",
              background: "#1a1714",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 4px 12px rgba(26,23,20,0.35)",
              cursor: "grab",
              touchAction: "none",
              transition: "transform 0.08s linear",
              transform: `translateX(${x}px)`,
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#fdfbf7"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
