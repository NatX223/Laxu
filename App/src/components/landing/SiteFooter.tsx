"use client";

import { FOOTER_LINKS } from "./data";
import { Grain, SERIF } from "./shared";
import { useNarrow } from "@/lib/landing";

export default function SiteFooter() {
  const narrow = useNarrow();

  return (
    <footer
      style={{
        position: "relative",
        overflow: "clip",
        background: "linear-gradient(180deg, #281f4c 0%, #211a3e 46%, #17122b 100%)",
      }}
    >
      <Grain opacity={0.18} />

      <div
        style={{
          position: "relative",
          maxWidth: 1180,
          margin: "0 auto",
          padding: "84px 24px 0",
        }}
      >
        <div
          style={{
            display: "grid",
            gap: 52,
            alignItems: "start",
            gridTemplateColumns: narrow ? "1fr" : "minmax(0, 0.92fr) minmax(0, 1.08fr)",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 18,
              maxWidth: "34ch",
            }}
          >
            <div
              style={{
                fontFamily: SERIF,
                fontStyle: "italic",
                fontSize: 54,
                lineHeight: 0.9,
                letterSpacing: "-0.03em",
                color: "#fdfbf7",
              }}
            >
              Laxu
            </div>
            <p
              style={{
                margin: 0,
                fontSize: 15,
                lineHeight: 1.6,
                fontWeight: 500,
                color: "#ded7f0",
                textWrap: "pretty",
              }}
            >
              The ownership layer for leveraged positions. Mint a trade into a token, then lend
              against it, sell it, or open it up.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, paddingTop: 4 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  color: "#ffd9a0",
                  border: "1px solid rgba(255,217,160,0.38)",
                  padding: "8px 14px",
                  borderRadius: 99,
                }}
              >
                ROBINHOOD CHAIN
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  color: "#cbb8ff",
                  border: "1px solid rgba(203,184,255,0.38)",
                  padding: "8px 14px",
                  borderRadius: 99,
                }}
              >
                POWERED BY ARCUS
              </div>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gap: 34,
              gridTemplateColumns: narrow
                ? "repeat(auto-fit, minmax(130px, 1fr))"
                : "repeat(3, minmax(0, 1fr))",
            }}
          >
            {FOOTER_LINKS.map((group) => (
              <div
                key={group.heading}
                style={{ display: "flex", flexDirection: "column", gap: 14 }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.18em",
                    color: "#9b8fc4",
                  }}
                >
                  {group.heading}
                </div>
                {group.links.map((link) => (
                  <a
                    key={link}
                    href="#"
                    className="laxu-foot-link"
                    style={{
                      fontSize: 15,
                      fontWeight: 500,
                      color: "#ded7f0",
                      textDecoration: "none",
                    }}
                  >
                    {link}
                  </a>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 18,
            marginTop: 56,
            padding: "22px 0 26px",
            borderTop: "1px solid rgba(255,255,255,0.14)",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 500, color: "#a99ccd" }}>© 2026 Laxu Labs</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
            {["Terms", "Privacy", "Risk disclosure"].map((link) => (
              <a
                key={link}
                href="#"
                className="laxu-foot-link"
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: "#a99ccd",
                  textDecoration: "none",
                }}
              >
                {link}
              </a>
            ))}
          </div>
        </div>

        <div
          style={{
            fontSize: 12,
            lineHeight: 1.6,
            fontWeight: 500,
            color: "#8d81b0",
            maxWidth: "88ch",
            paddingBottom: 34,
            textWrap: "pretty",
          }}
        >
          Leveraged positions can be liquidated in full. Position tokens carry the market risk of
          the underlying trade plus smart-contract risk, and are not deposits, securities, or
          insured instruments. Nothing here is financial advice.
        </div>

        {/* oversized watermark, bled off the bottom edge */}
        <div
          aria-hidden="true"
          style={{
            fontFamily: SERIF,
            fontStyle: "italic",
            fontSize: "20vw",
            lineHeight: 0.74,
            letterSpacing: "-0.04em",
            color: "rgba(253,251,247,0.07)",
            textAlign: "center",
            userSelect: "none",
            pointerEvents: "none",
            marginBottom: "-0.16em",
          }}
        >
          Laxu
        </div>
      </div>
    </footer>
  );
}
