import { COPY } from "./data";
import { Grain, SERIF } from "./shared";

/**
 * Full-viewport opener: dusk gradient, grain, minimal nav, oversized wordmark.
 */
export default function Hero() {
  return (
    <section
      style={{
        position: "relative",
        overflow: "hidden",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background:
          "radial-gradient(68% 46% at 50% 110%, #e0651c 0%, rgba(224,101,28,0) 62%), radial-gradient(92% 58% at 50% 98%, #f0a24a 0%, rgba(240,162,74,0) 70%), radial-gradient(124% 78% at 50% 76%, #dba4b4 0%, rgba(219,164,180,0) 76%), linear-gradient(180deg, #a9b6cd 0%, #b3aacd 26%, #c7a8c6 48%, #ddb0ae 68%, #eec296 87%, #f4c68a 100%)",
      }}
    >
      <Grain />

      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          padding: "22px 32px",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- intrinsic-height mark, no layout box to reserve */}
        <img
          src="/laxu/laxu-mark.png"
          alt="Laxu"
          style={{
            height: 44,
            width: "auto",
            display: "block",
            filter: "drop-shadow(0 4px 14px rgba(26,23,20,0.18))",
          }}
        />
        <a
          href="#"
          className="laxu-nav-cta"
          style={{
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: "0.02em",
            color: "#fdfbf7",
            background: "#5b2fd6",
            padding: "11px 20px",
            borderRadius: 99,
            whiteSpace: "nowrap",
            textDecoration: "none",
            boxShadow: "0 6px 18px rgba(91,47,214,0.3)",
          }}
        >
          {COPY.navCtaLabel}
        </a>
      </div>

      <div
        style={{
          position: "relative",
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 26,
          padding: "40px 32px 90px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontFamily: SERIF,
            fontStyle: "italic",
            fontSize: "clamp(96px, 17vw, 240px)",
            lineHeight: 0.88,
            letterSpacing: "-0.03em",
            color: "#16130f",
            textShadow: "0 6px 30px rgba(26,23,20,0.14)",
          }}
        >
          Laxu
        </div>

        <h1
          style={{
            margin: 0,
            fontFamily: SERIF,
            fontWeight: 400,
            fontSize: "clamp(30px, 4.4vw, 54px)",
            lineHeight: 1.08,
            letterSpacing: "-0.015em",
            color: "#1a1714",
            maxWidth: "18ch",
          }}
        >
          Shapeshift your <i>positions</i>
        </h1>

        <p
          style={{
            margin: 0,
            maxWidth: 620,
            fontSize: 16,
            lineHeight: 1.6,
            fontWeight: 500,
            color: "#2e2822",
            textWrap: "pretty",
          }}
        >
          Open a leveraged position and mint it as an ERC-20 you actually own. One token, one
          position — its own entry, size and leverage.
        </p>

        <a
          href="#"
          className="laxu-hero-cta"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 15,
            fontWeight: 600,
            color: "#fdfbf7",
            background: "#1a1714",
            padding: "7px 8px 7px 24px",
            borderRadius: 99,
            textDecoration: "none",
            boxShadow: "0 10px 26px rgba(26,23,20,0.28)",
          }}
        >
          <span style={{ paddingRight: 12, whiteSpace: "nowrap" }}>{COPY.ctaLabel}</span>
          <span
            style={{
              width: 34,
              height: 34,
              borderRadius: "50%",
              background: "#fdfbf7",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#1a1714"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="7" y1="17" x2="17" y2="7" />
              <polyline points="8 7 17 7 17 16" />
            </svg>
          </span>
        </a>

        {COPY.showChainCredit && (
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.1em",
              color: "#4a4038",
              textTransform: "uppercase",
            }}
          >
            Built on Robinhood Chain · powered by Arcus
          </div>
        )}
      </div>
    </section>
  );
}
