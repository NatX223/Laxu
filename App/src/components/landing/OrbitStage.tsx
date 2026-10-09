"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { COPY, POSITION_CARDS } from "./data";
import PositionCard from "./PositionCard";
import { Grain, SERIF } from "./shared";
import { useNarrow, useRevealed } from "@/lib/landing";

/** The orbit is authored at a fixed 1200px square and scaled down to fit. */
const STAGE = 1200;
const SPIN_SECONDS = 78;

export default function OrbitStage() {
  const { ref: hostRef, revealed } = useRevealed<HTMLElement>(0.12);
  const [scale, setScale] = useState(1);
  const [hover, setHover] = useState(false);
  const narrow = useNarrow();

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
  const { ref: tickerRef, ticking } = useTicker(narrow && revealed && COPY.spin);
  // the ticker loops over a doubled set; the copies are hidden from screen readers
  const rowCards = [
    ...POSITION_CARDS.map((card) => ({ card, copy: false })),
    ...(ticking ? POSITION_CARDS.map((card) => ({ card, copy: true })) : []),
  ];

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

      {narrow ? (
        // phones: the ring would shrink the cards past legibility, so they swipe instead
        <div
          style={{
            position: "relative",
            transition: "opacity 1s ease",
            opacity: revealed ? 1 : 0,
          }}
        >
          <Headline titleSize="clamp(34px, 9vw, 46px)" style={{ padding: "72px 20px 8px" }} />
          <div
            ref={tickerRef}
            className="laxu-swipe-row"
            style={{
              display: "flex",
              gap: 16,
              overflowX: "auto",
              // snapping would fight the drift, so it only applies to the static swiper
              scrollSnapType: ticking ? "none" : "x mandatory",
              padding: "28px 20px 76px",
            }}
          >
            {rowCards.map(({ card, copy }) => (
              <div
                key={`${card.title}${copy ? "-copy" : ""}`}
                aria-hidden={copy || undefined}
                style={{ flex: "none", width: "min(300px, 80vw)", scrollSnapAlign: "center" }}
              >
                <PositionCard card={card} />
              </div>
            ))}
          </div>
        </div>
      ) : (
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

          <Headline
            titleSize={50}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 420,
              transform: "translate(-50%, -50%)",
            }}
          />
        </div>
      </div>
      )}
    </section>
  );
}

const DRIFT_PX_PER_SEC = 42;
const RESUME_AFTER_MS = 2500;

/**
 * Drifts the phone swipe row sideways at a steady pace, like a ticker. The cards are
 * rendered twice, so once the row has drifted one full set it jumps back by that
 * width, which lands on an identical frame. A touch, drag or wheel hands the row to
 * the user; drifting picks up again from wherever they leave it.
 * `ticking` is false under reduced motion, and the row then stays a plain snap-swiper.
 */
function useTicker(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [motionOk, setMotionOk] = useState(false);

  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setMotionOk(!q.matches);
    sync();
    q.addEventListener("change", sync);
    return () => q.removeEventListener("change", sync);
  }, []);

  const ticking = active && motionOk;

  useEffect(() => {
    const row = ref.current;
    if (!ticking || !row) return;

    let lastTouch = 0;
    let frame = 0;
    let prev = 0;
    // scrollLeft can round to whole pixels, so the sub-pixel position lives here
    let pos = row.scrollLeft;

    const touched = () => {
      lastTouch = Date.now();
    };
    const events = ["pointerdown", "touchstart", "wheel"] as const;
    events.forEach((e) => row.addEventListener(e, touched, { passive: true }));

    // width of one set of cards: from the first card to its duplicate
    const loopWidth = () => {
      const half = row.children.length / 2;
      const a = row.children[0] as HTMLElement | undefined;
      const b = row.children[half] as HTMLElement | undefined;
      return a && b ? b.offsetLeft - a.offsetLeft : 0;
    };

    const step = (now: number) => {
      const dt = prev ? Math.min(now - prev, 100) : 0;
      prev = now;
      const loop = loopWidth();
      if (Date.now() - lastTouch < RESUME_AFTER_MS || loop <= 0) {
        pos = row.scrollLeft;
      } else {
        pos += (DRIFT_PX_PER_SEC * dt) / 1000;
        if (pos >= loop) pos -= loop;
        row.scrollLeft = pos;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(frame);
      events.forEach((e) => row.removeEventListener(e, touched));
    };
  }, [ticking]);

  return { ref, ticking };
}

/** Eyebrow, title and blurb: centred in the ring, or stacked above the cards on phones. */
function Headline({ titleSize, style }: { titleSize: number | string; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 14,
        textAlign: "center",
        ...style,
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
        YOUR POSITION, TOKENIZED
      </div>
      <div
        style={{
          fontFamily: SERIF,
          fontSize: titleSize,
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
        Trade on Perpl, get a token on Monad, borrow against it. The token reads its price from
        Perpl on-chain.
      </div>
    </div>
  );
}
