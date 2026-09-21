"use client";

import Link from "next/link";
import { useState } from "react";
import { COPY, CTA_STATS, FAQS } from "./data";
import { Grain, SERIF } from "./shared";
import { useNarrow } from "@/lib/landing";

export default function CtaFaq() {
  const narrow = useNarrow();
  // the first question starts open
  const [open, setOpen] = useState<Record<number, boolean>>({ 0: true });

  const toggle = (i: number) =>
    setOpen((prev) =>
      COPY.faqMultiOpen ? { ...prev, [i]: !prev[i] } : prev[i] ? {} : { [i]: true },
    );

  return (
    <section
      style={{
        position: "relative",
        overflow: "clip",
        background:
          "linear-gradient(180deg, #a9b6cd 0%, #9ea4c9 12%, #8d8bbe 30%, #6f62a4 54%, #443779 78%, #281f4c 100%)",
      }}
    >
      <Grain />

      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          gap: 90,
          padding: "110px 24px 130px",
          maxWidth: 1180,
          margin: "0 auto",
        }}
      >
        <div
          style={{
            backdropFilter: "blur(20px) saturate(1.3)",
            WebkitBackdropFilter: "blur(20px) saturate(1.3)",
            background: "rgba(253,251,247,0.66)",
            border: "1px solid rgba(255,255,255,0.8)",
            borderRadius: 30,
            boxShadow: "0 34px 74px rgba(26,23,20,0.22)",
            padding: "56px 44px 48px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 22,
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.18em",
              color: "#5b2fd6",
            }}
          >
            GET STARTED
          </div>
          <h2
            style={{
              margin: 0,
              fontFamily: SERIF,
              fontWeight: 400,
              fontSize: "clamp(40px, 6vw, 86px)",
              lineHeight: 0.98,
              letterSpacing: "-0.024em",
              color: "#16130f",
              maxWidth: "18ch",
              textWrap: "balance",
            }}
          >
            Your position is <i>an asset</i>
          </h2>
          <p
            style={{
              margin: 0,
              fontSize: 17,
              lineHeight: 1.6,
              fontWeight: 500,
              color: "#2e2822",
              maxWidth: "52ch",
              textWrap: "pretty",
            }}
          >
            Open a trade on Arcus, wrap it with Laxu, and it becomes something you can borrow
            against, sell outright, or open up to other traders.
          </p>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "center",
              gap: 12,
              paddingTop: 10,
            }}
          >
            <Link
              href="/trade"
              className="laxu-cta-primary"
              style={{
                fontSize: 15,
                fontWeight: 700,
                letterSpacing: "0.01em",
                color: "#fdfbf7",
                background: "#5b2fd6",
                border: "1px solid rgba(255,255,255,0.28)",
                padding: "16px 30px",
                borderRadius: 99,
                textDecoration: "none",
                boxShadow: "0 16px 34px rgba(46,18,112,0.32)",
                transition: "transform 0.25s ease, box-shadow 0.25s ease",
              }}
            >
              {COPY.ctaLabel}
            </Link>
            <a
              href="#"
              className="laxu-cta-secondary"
              style={{
                fontSize: 15,
                fontWeight: 700,
                letterSpacing: "0.01em",
                color: "#16130f",
                background: "rgba(255,255,255,0.72)",
                border: "1px solid rgba(26,23,20,0.16)",
                padding: "16px 28px",
                borderRadius: 99,
                textDecoration: "none",
                transition: "background 0.25s ease",
              }}
            >
              {COPY.secondaryCtaLabel}
            </a>
          </div>

          {COPY.showCtaStats && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "center",
                gap: 10,
                paddingTop: 18,
              }}
            >
            </div>
          )}
        </div>

        <div
          style={{
            display: "grid",
            gap: 34,
            alignItems: "start",
            gridTemplateColumns: narrow ? "1fr" : "minmax(0, 0.78fr) minmax(0, 1.22fr)",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              position: "sticky",
              top: narrow ? "auto" : "18vh",
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.18em",
                color: "#ffd9a0",
              }}
            >
              FAQ
            </div>
            <div
              style={{
                fontFamily: SERIF,
                fontSize: "clamp(32px, 4vw, 52px)",
                lineHeight: 1.04,
                letterSpacing: "-0.018em",
                color: "#fdfbf7",
              }}
            >
              Before you
              <br />
              tokenize
            </div>
            <p
              style={{
                margin: 0,
                fontSize: 15,
                lineHeight: 1.6,
                fontWeight: 500,
                color: "#e4ddf3",
                maxWidth: "32ch",
                textWrap: "pretty",
              }}
            >
              The mechanics people ask about most. Anything else, the docs go deeper.
            </p>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {FAQS.map((item, i) => {
              const isOpen = !!open[i];
              return (
                <div
                  key={item.q}
                  style={{
                    backdropFilter: "blur(18px) saturate(1.25)",
                    WebkitBackdropFilter: "blur(18px) saturate(1.25)",
                    background: "rgba(253,251,247,0.72)",
                    border: "1px solid rgba(255,255,255,0.78)",
                    borderRadius: 18,
                    boxShadow: "0 16px 34px rgba(18,14,34,0.18)",
                    overflow: "hidden",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggle(i)}
                    aria-expanded={isOpen}
                    style={{
                      appearance: "none",
                      border: "none",
                      background: "transparent",
                      font: "inherit",
                      textAlign: "left",
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 18,
                      padding: "22px 24px",
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 17,
                        fontWeight: 700,
                        lineHeight: 1.35,
                        color: "#16130f",
                        textWrap: "pretty",
                      }}
                    >
                      {item.q}
                    </span>
                    {/* two bars: the second rotates to 90deg to form a plus */}
                    <span
                      aria-hidden="true"
                      style={{
                        position: "relative",
                        flex: "none",
                        width: 22,
                        height: 22,
                        borderRadius: 99,
                        background: "#5b2fd6",
                      }}
                    >
                      <span
                        style={{
                          position: "absolute",
                          top: 10,
                          left: 6,
                          width: 10,
                          height: 2,
                          background: "#fdfbf7",
                          borderRadius: 2,
                        }}
                      />
                      <span
                        style={{
                          position: "absolute",
                          top: 10,
                          left: 6,
                          width: 10,
                          height: 2,
                          background: "#fdfbf7",
                          borderRadius: 2,
                          transition: "transform 0.3s ease",
                          transform: `rotate(${isOpen ? "0deg" : "90deg"})`,
                        }}
                      />
                    </span>
                  </button>
                  <div
                    style={{
                      display: "grid",
                      transition: "grid-template-rows 0.38s ease",
                      gridTemplateRows: isOpen ? "1fr" : "0fr",
                    }}
                  >
                    <div style={{ overflow: "hidden", minHeight: 0 }}>
                      <p
                        style={{
                          margin: 0,
                          fontSize: 16,
                          lineHeight: 1.65,
                          fontWeight: 500,
                          color: "#2e2822",
                          padding: "0 24px 24px",
                          maxWidth: "62ch",
                          textWrap: "pretty",
                        }}
                      >
                        {item.a}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
