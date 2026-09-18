"use client";

import { ASSET_CLASSES } from "./data";
import { Grain, SERIF } from "./shared";
import { useBandIndex, useNarrow } from "@/lib/landing";

/**
 * A sticky 88vh panel pinned over three 100vh spacers: scrolling the spacers
 * crossfades between asset classes and lights the matching pill.
 */
export default function AssetsSection() {
  const narrow = useNarrow();
  const asset = useBandIndex("data-asset-index");

  return (
    <section
      style={{
        position: "relative",
        overflow: "clip",
        background:
          "linear-gradient(180deg, #f4c68a 0%, #eec296 14%, #ddb0ae 38%, #c7a8c6 62%, #b3aacd 82%, #a9b6cd 100%)",
      }}
    >
      <Grain />

      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          gap: 40,
          padding: "100px 24px 120px",
          maxWidth: 1320,
          margin: "0 auto",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 700 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.18em",
              color: "#5b2fd6",
            }}
          >
            WHAT YOU CAN TOKENIZE
          </div>
          <h2
            style={{
              margin: 0,
              fontFamily: SERIF,
              fontWeight: 400,
              fontSize: "clamp(34px, 4.6vw, 58px)",
              lineHeight: 1.04,
              letterSpacing: "-0.018em",
              color: "#16130f",
            }}
          >
            Three markets, one <i>primitive</i>
          </h2>
          <p
            style={{
              margin: 0,
              fontSize: 16,
              lineHeight: 1.6,
              fontWeight: 500,
              color: "#2e2822",
              textWrap: "pretty",
            }}
          >
            Anything Arcus can open, Laxu can wrap. Same tokenization, same lending and buy-in
            rails, whatever the underlying is.
          </p>
        </div>

        <div style={{ position: "relative" }}>
          <div
            style={{
              position: "sticky",
              top: "6vh",
              height: "88vh",
              marginBottom: "-88vh",
              zIndex: 2,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "center",
                gap: 8,
              }}
            >
              {ASSET_CLASSES.map((item, i) => (
                <div
                  key={item.pill}
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: "0.1em",
                    border: "1px solid rgba(255,255,255,0.8)",
                    padding: "8px 15px",
                    borderRadius: 99,
                    whiteSpace: "nowrap",
                    transition: "color 0.45s ease, background 0.45s ease",
                    // full-opacity ink in both states — fading the element
                    // composites the text and the frost together
                    color: asset === i ? "#16130f" : "#6f6659",
                    background:
                      asset === i ? "rgba(253,251,247,0.72)" : "rgba(253,251,247,0.45)",
                  }}
                >
                  {item.pill}
                </div>
              ))}
            </div>

            <div style={{ position: "relative", flex: 1, minHeight: 0, width: "100%" }}>
              {ASSET_CLASSES.map((item, i) => (
                <div
                  key={item.title}
                  style={{
                    position: "absolute",
                    inset: 0,
                    transition: "opacity 0.6s ease",
                    opacity: asset === i ? 1 : 0,
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      backdropFilter: "blur(22px) saturate(1.3)",
                      WebkitBackdropFilter: "blur(22px) saturate(1.3)",
                      background: "rgba(253,251,247,0.62)",
                      border: "1px solid rgba(255,255,255,0.8)",
                      borderRadius: 26,
                      overflow: "hidden",
                      boxShadow: "0 30px 66px rgba(26,23,20,0.2)",
                      display: "grid",
                      gridTemplateColumns: narrow
                        ? "1fr"
                        : "minmax(0, 0.92fr) minmax(0, 1.08fr)",
                    }}
                  >
                    <div
                      style={{
                        minWidth: 0,
                        minHeight: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 30,
                        background: item.glow,
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- crossfading stack, intrinsic sizing */}
                      <img
                        src={item.src}
                        alt={item.alt}
                        style={{
                          maxWidth: "100%",
                          maxHeight: "100%",
                          width: "auto",
                          height: "auto",
                          display: "block",
                          filter: item.dropShadow,
                        }}
                      />
                    </div>
                    <div
                      style={{
                        minWidth: 0,
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "center",
                        gap: 16,
                        padding: "36px 44px 36px 8px",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                        <div
                          style={{
                            fontFamily: SERIF,
                            fontSize: "clamp(38px, 4.4vw, 60px)",
                            lineHeight: 1.02,
                            letterSpacing: "-0.02em",
                            color: "#16130f",
                          }}
                        >
                          {item.title}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: "0.1em",
                            color: "#fdfbf7",
                            background: item.badgeBg,
                            padding: "5px 11px",
                            borderRadius: 99,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {item.badge}
                        </div>
                      </div>
                      <p
                        style={{
                          margin: 0,
                          fontSize: 18,
                          lineHeight: 1.6,
                          fontWeight: 500,
                          color: "#2e2822",
                          maxWidth: "42ch",
                          textWrap: "pretty",
                        }}
                      >
                        {item.body}
                      </p>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 8,
                          paddingTop: 4,
                        }}
                      >
                        {item.tags.map((tag) => (
                          <div
                            key={tag}
                            style={{
                              fontSize: 13,
                              fontWeight: 700,
                              color: "#4a4038",
                              background: "rgba(255,255,255,0.62)",
                              border: "1px solid rgba(26,23,20,0.14)",
                              padding: "7px 13px",
                              borderRadius: 99,
                            }}
                          >
                            {tag}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* scroll runway: one viewport per asset class */}
          {ASSET_CLASSES.map((item, i) => (
            <div key={item.pill} data-asset-index={i} style={{ minHeight: "100vh" }} />
          ))}
        </div>
      </div>
    </section>
  );
}
