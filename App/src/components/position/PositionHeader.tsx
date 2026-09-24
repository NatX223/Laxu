import Link from "next/link";
import { Disc } from "../community/shared";
import { Badge, MONO, SERIF } from "./shared";
import type { PositionVals } from "./derive";

/** The gradient band: back link, the position's identity, and NAV per token. */
export default function PositionHeader({ vals }: { vals: PositionVals }) {
  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        borderBottom: "1px solid rgba(255,255,255,0.1)",
        background:
          "radial-gradient(70% 130% at 12% 0%, #3b2a78 0%, rgba(59,42,120,0) 60%), radial-gradient(64% 120% at 88% 8%, #6b3a86 0%, rgba(107,58,134,0) 56%), linear-gradient(180deg, #241c46 0%, #1e1740 70%, #1c1638 100%)",
      }}
    >
      <div
        style={{
          position: "relative",
          zIndex: 2,
          maxWidth: 1280,
          margin: "0 auto",
          padding: "22px 28px 30px",
          display: "flex",
          flexDirection: "column",
          gap: 22,
        }}
      >
        <Link
          href="/community"
          className="laxu-back"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            alignSelf: "flex-start",
            fontSize: 12,
            fontWeight: 600,
            color: "#a79bd0",
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="15 6 9 12 15 18" />
          </svg>
          Community tokens
        </Link>

        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 28,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16, minWidth: 0 }}>
            <Disc
              size={58}
              font={22}
              base={vals.base}
              logo={vals.logo}
              style={{ boxShadow: "0 10px 26px rgba(10,6,28,0.45)" }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 9, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                <h1
                  style={{
                    margin: 0,
                    fontFamily: SERIF,
                    fontWeight: 400,
                    fontSize: 40,
                    lineHeight: 1,
                    letterSpacing: "-0.02em",
                    color: "#fdfbf7",
                  }}
                >
                  {vals.nickname}
                </h1>
                <div style={{ fontSize: 16, fontWeight: 600, color: "#c2b6e4" }}>{vals.structuredName}</div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Badge bg={vals.statusBg} ink={vals.statusInk}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: vals.statusInk }} />
                  {vals.statusLabel}
                </Badge>

                <Badge bg={vals.sideBg} ink={vals.sideInk}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ transform: `rotate(${vals.sideRotate}deg)` }}
                    aria-hidden="true"
                  >
                    <line x1="7" y1="17" x2="17" y2="7" />
                    <polyline points="8 7 17 7 17 16" />
                  </svg>
                  {vals.sideLabel}
                </Badge>

                <Badge bg="rgba(255,183,101,0.16)" ink="#ffd9a0">
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <line x1="7" y1="4" x2="7" y2="20" />
                    <rect x="4" y="9" width="6" height="7" rx="1.4" />
                    <line x1="17" y1="4" x2="17" y2="20" />
                    <rect x="14" y="6" width="6" height="11" rx="1.4" />
                  </svg>
                  {vals.levLabel}
                </Badge>

                {vals.collateralized && (
                  <Badge
                    href="#"
                    className="laxu-loan-chip"
                    bg="rgba(150,112,255,0.2)"
                    ink="#d5c6ff"
                    style={{ border: "1px solid rgba(150,112,255,0.5)" }}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="4" y="10" width="16" height="10" rx="2.4" />
                      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                    </svg>
                    COLLATERALIZED &middot; {vals.loanLabel}
                  </Badge>
                )}
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                  fontFamily: MONO,
                  fontSize: 11.5,
                  color: "#8f85bd",
                }}
              >
                <span>{vals.ticker}</span>
                <span>&middot;</span>
                <span>{vals.addr}</span>
                <span>&middot;</span>
                <span>created by {vals.creator}</span>
                <span>&middot;</span>
                <span>{vals.ageLabel}</span>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" }}>
              NAV PER TOKEN
            </div>
            <div style={{ fontFamily: MONO, fontSize: 38, lineHeight: 1, fontWeight: 600, color: "#fdfbf7" }}>
              {vals.navPrice}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600, color: vals.pnlColor }}>
              {vals.navChg} &middot; {vals.navChgAbs}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
