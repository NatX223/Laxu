"use client";

import { useCallback, useEffect, useState } from "react";
import { COPY, POSITION_CARDS } from "./data";
import PositionCard from "./PositionCard";
import { Grain, SERIF } from "./shared";
import { useRevealed } from "@/lib/landing";

/** The orbit is authored at a fixed 1200px square and scaled down to fit. */
const STAGE = 1200;
const SPIN_SECONDS = 78;

export default function OrbitStage() {
  const { ref: hostRef, revealed } = useRevealed<HTMLElement>(0.12);
  const [scale, setScale] = useState(1);
  const [hover, setHover] = useState(false);

  const fit = useCallback(() => {
    const el = hostRef.current;
    if (!el) return;
    const w = el.clientWidth || STAGE;
    const next = Math.max(0.3, Math.min(1, (w - 36) / (STAGE + 40)));
    setScale((prev) => (Math.abs(next - prev) > 0.002 ? next : prev));
  }, [hostRef]);

  useEffect(() => {
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fit]);

  const play = COPY.spin && !hover ? "running" : "paused";

  return (
    <section
      ref={hostRef}
      style={{
        position: "relative",
        overflow: "hidden",
        background:
          "linear-gradient(180deg, #f4c68a 0%, #ebb692 16%, #e0aca8 30%, #d6a8bd 46%, #c0a6c8 66%, #ada7cd 85%, #a9b6cd 100%)",
      }}
    >
      <Grain />

      <div
        style={{
          position: "relative",
          display: "flex",
          justifyContent: "center",
          height: Math.round(STAGE * scale),
        }}
      >
        <div
          style={{
            position: "relative",
            width: STAGE,
            height: STAGE,
            flex: "none",
            transformOrigin: "top center",
            transition: "opacity 1s ease",
            transform: `scale(${scale})`,
            opacity: revealed ? 1 : 0,
          }}
        >
          <div
            className="laxu-orbit-ring"
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              animation: `laxu-orbit ${SPIN_SECONDS}s linear infinite`,
              willChange: "transform",
              animationPlayState: play,
            }}
          >
            {POSITION_CARDS.map((card) => (
              <div
                key={card.title}
                onMouseEnter={() => setHover(true)}
                onMouseLeave={() => setHover(false)}
                style={{
                  pointerEvents: "auto",
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: 330,
                  transform: `translate(-50%, -50%) rotate(${card.angle}deg) translateX(${card.radius}px) rotate(${-card.angle}deg)`,
                }}
              >
                {/* cancels the ring's rotation so each card stays upright */}
                <div
                  className="laxu-orbit-counter"
                  style={{
                    animation: `laxu-counter ${SPIN_SECONDS}s linear infinite`,
                    transformOrigin: "50% 50%",
                    animationPlayState: play,
                  }}
                >
                  <PositionCard card={card} />
                </div>
              </div>
            ))}
          </div>

          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 420,
              transform: "translate(-50%, -50%)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 14,
              textAlign: "center",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: "0.2em",
                color: "#5b2fd6",
              }}
            >
              ONE POSITION, ONE TOKEN
            </div>
            <div
              style={{
                fontFamily: SERIF,
                fontSize: 50,
                lineHeight: 1.06,
                letterSpacing: "-0.015em",
                color: "#1a1714",
              }}
            >
              Every trade becomes an <i>asset</i>
            </div>
            <div
              style={{
                fontSize: 16,
                lineHeight: 1.6,
                fontWeight: 500,
                color: "#2e2822",
                textWrap: "pretty",
              }}
            >
              Slide to mint. From there it lends, trades and splits like any other token on
              Robinhood Chain.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
