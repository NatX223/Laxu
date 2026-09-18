"use client";

import { FLOWS } from "./data";
import { Grain, SERIF } from "./shared";
import { useBandIndex, useNarrow } from "@/lib/landing";

/**
 * Sticky screenshot on the left, three tall copy rows on the right.
 * Whichever row crosses the centre of the viewport owns the image.
 */
export default function FlowSection() {
  const narrow = useNarrow();
  const active = useBandIndex("data-fade-index");

  return (
    <section
      style={{
        position: "relative",
        overflow: "clip",
        background:
          "linear-gradient(180deg, #a9b6cd 0%, #b3aacd 22%, #c7a8c6 44%, #ddb0ae 66%, #eec296 86%, #f4c68a 100%)",
      }}
    >
      <Grain />

      <div
        style={{
          position: "relative",
          // mobile: block flow so the image pins to the top of the whole section
          display: narrow ? "block" : "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 60,
          padding: "90px 32px 110px",
          maxWidth: 1180,
          margin: "0 auto",
          alignItems: "start",
        }}
      >
        <div
          style={{
            position: "sticky",
            zIndex: 2,
            display: "flex",
            alignItems: "center",
            top: narrow ? "12px" : "14vh",
            height: narrow ? "auto" : "72vh",
          }}
        >
          <div
            style={{
              position: "relative",
              width: "100%",
              aspectRatio: "60 / 47",
              borderRadius: 22,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.72)",
              boxShadow: "0 24px 56px rgba(26,23,20,0.18)",
              margin: "0 auto",
              // cap width, not height — a height cap fights aspect-ratio and crops the CTA off
              maxWidth: narrow ? "min(100%, calc(42vh * 60 / 47))" : "100%",
            }}
          >
            {FLOWS.map((flow, i) => (
              <div
                key={flow.title}
                style={{
                  position: "absolute",
                  inset: 0,
                  transition: "opacity 0.6s ease",
                  opacity: active === i ? 1 : 0,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- crossfading stack, all three stay mounted */}
                <img
                  src={flow.src}
                  alt={flow.alt}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    display: "block",
                  }}
                />
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            paddingTop: narrow ? 34 : 0,
          }}
        >
          {FLOWS.map((flow, i) => (
            <div
              key={flow.title}
              data-fade-index={i}
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                minHeight: narrow ? "58vh" : "86vh",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.18em",
                    color: flow.eyebrowInk,
                  }}
                >
                  {flow.eyebrow}
                </div>
                <h2
                  style={{
                    margin: 0,
                    fontFamily: SERIF,
                    fontWeight: 400,
                    fontSize: "clamp(38px, 5vw, 66px)",
                    lineHeight: 1.02,
                    letterSpacing: "-0.02em",
                    color: "#16130f",
                  }}
                >
                  {flow.title}
                </h2>
                <p
                  style={{
                    margin: 0,
                    fontSize: 17,
                    lineHeight: 1.65,
                    fontWeight: 500,
                    color: "#2e2822",
                    maxWidth: "46ch",
                    textWrap: "pretty",
                  }}
                >
                  {flow.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
