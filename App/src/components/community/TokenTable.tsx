"use client";

import Link from "next/link";
import type { CommunityEngine } from "./engine";
import { Disc, MONO } from "./shared";

/** The ten-column grid the header and every row share. */
const GRID: React.CSSProperties = {
  minWidth: 1040,
  display: "grid",
  gridTemplateColumns:
    "34px minmax(170px, 2fr) 96px minmax(96px, 1fr) 86px 112px minmax(104px, 1fr) 92px minmax(104px, 1fr) 92px",
  gap: 10,
  alignItems: "center",
};

const PAGER: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  borderRadius: 10,
  cursor: "pointer",
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(255,255,255,0.05)",
};

/** Everything below the spotlight: the ranked rows and the pager. */
export default function TokenTable({ engine }: { engine: CommunityEngine }) {
  const { vals, buy, goto, prev, next } = engine;

  return (
    <div
      style={{
        borderRadius: 18,
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(255,255,255,0.04)",
        backdropFilter: "blur(16px)",
      }}
    >
      <div style={{ overflowX: "auto", overflowY: "hidden" }}>
        <div
          style={{
            ...GRID,
            padding: "11px 18px",
            background: "rgba(255,255,255,0.05)",
            borderBottom: "1px solid rgba(255,255,255,0.1)",
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.1em",
            color: "#a79bd0",
          }}
        >
          <div>#</div>
          <div>POSITION TOKEN</div>
          <div>SIDE</div>
          <div style={{ textAlign: "right" }}>PRICE</div>
          <div style={{ textAlign: "right" }}>24H</div>
          <div style={{ textAlign: "center" }}>7D TREND</div>
          <div style={{ textAlign: "right" }}>VOL. 24H</div>
          <div style={{ textAlign: "right" }}>HOLDERS</div>
          <div style={{ textAlign: "right" }}>NOTIONAL</div>
          <div />
        </div>

        {vals.rows.map((t) => (
          <div
            key={t.sym}
            className="laxu-row"
            style={{ ...GRID, padding: "12px 18px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}
          >
            <div style={{ fontFamily: MONO, fontSize: 12, color: "#6f66a0" }}>{t.rank}</div>

            <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
              <Disc size={28} font={12} accent={t.accent} logo={t.logo} initial={t.initial} />
              <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <Link
                  href="/position"
                  className="laxu-row-title"
                  style={{
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: "#fdfbf7",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    transition: "color 0.15s ease",
                  }}
                >
                  {t.title}
                </Link>
                <div
                  style={{
                    fontFamily: MONO,
                    fontSize: 10.5,
                    color: "#8f85bd",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t.creator}
                </div>
              </div>
            </div>

            <div>
              <span
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  padding: "4px 9px",
                  borderRadius: 99,
                  whiteSpace: "nowrap",
                  background: t.sideBg,
                  color: t.sideInk,
                }}
              >
                {t.sideLabel}
              </span>
            </div>

            <div style={{ textAlign: "right", fontFamily: MONO, fontSize: 13, color: "#fdfbf7" }}>{t.price}</div>
            <div style={{ textAlign: "right", fontFamily: MONO, fontSize: 13, fontWeight: 600, color: t.c }}>{t.chg}</div>

            <div>
              <svg
                viewBox="0 0 300 76"
                preserveAspectRatio="none"
                aria-hidden="true"
                style={{ display: "block", width: "100%", height: 30 }}
              >
                <path
                  d={t.line}
                  fill="none"
                  stroke={t.c}
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </div>

            <div style={{ textAlign: "right", fontFamily: MONO, fontSize: 13, color: "#fdfbf7" }}>{t.vol}</div>
            <div style={{ textAlign: "right", fontFamily: MONO, fontSize: 13, color: "#c2b6e4" }}>{t.holders}</div>
            <div style={{ textAlign: "right", fontFamily: MONO, fontSize: 13, color: "#c2b6e4" }}>{t.notional}</div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <div
                onClick={() => buy(t.token)}
                className="laxu-row-buy"
                style={{
                  fontSize: 11.5,
                  fontWeight: 700,
                  color: "#d5c6ff",
                  border: "1px solid rgba(150,112,255,0.55)",
                  background: "rgba(150,112,255,0.14)",
                  padding: "7px 14px",
                  borderRadius: 99,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                Buy in
              </div>
            </div>
          </div>
        ))}

        {vals.empty && (
          <div style={{ padding: "54px 20px", textAlign: "center", fontSize: 13.5, fontWeight: 500, color: "#a79bd0" }}>
            No position tokens match that search.
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
          padding: "13px 18px",
          background: "rgba(255,255,255,0.04)",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 500, color: "#a79bd0" }}>{vals.rangeLabel}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div
            onClick={prev}
            className="laxu-pager"
            role="button"
            aria-label="Previous page"
            style={{ ...PAGER, color: vals.prevInk }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 6 9 12 15 18" />
            </svg>
          </div>
          {vals.pages.map((p) => (
            <div
              key={p.n}
              onClick={() => goto(p.n)}
              style={{
                minWidth: 32,
                height: 32,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "0 9px",
                borderRadius: 10,
                cursor: "pointer",
                fontFamily: MONO,
                fontSize: 12.5,
                fontWeight: 600,
                border: `1px solid ${p.border}`,
                background: p.bg,
                color: p.ink,
              }}
            >
              {p.label}
            </div>
          ))}
          <div
            onClick={next}
            className="laxu-pager"
            role="button"
            aria-label="Next page"
            style={{ ...PAGER, color: vals.nextInk }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
