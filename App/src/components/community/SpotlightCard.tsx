import Link from "next/link";
import Sparkline from "../charts/LazySparkline";
import type { Card } from "./derive";
import { Disc, MONO, SERIF } from "./shared";

const KEY: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" };

/** One top performer: header, price, sparkline, three stats and the buy-in. */
export default function SpotlightCard({ t, onBuy }: { t: Card; onBuy: () => void }) {
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        borderRadius: 20,
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.16)",
        background: "rgba(255,255,255,0.055)",
        backdropFilter: "blur(18px)",
        boxShadow: "0 24px 48px rgba(10,6,28,0.4)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "16px 18px",
          background: t.headBg,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
          <Disc size={34} font={14} accent={t.accent} logo={t.logo} initial={t.initial} />
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <Link
              href="/position"
              className="laxu-spot-title"
              style={{ fontFamily: SERIF, fontSize: 21, lineHeight: 1.05, color: "#fdfbf7", transition: "color 0.15s ease" }}
            >
              {t.title}
            </Link>
            <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#c2b6e4" }}>{t.sym}</div>
          </div>
        </div>
        <div style={{ flex: "none", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
          <div
            style={{
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: "0.1em",
              padding: "4px 9px",
              borderRadius: 99,
              background: t.sideBg,
              color: t.sideInk,
            }}
          >
            {t.sideLabel}
          </div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "#ffd9a0" }}>RANK {t.rank}</div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, padding: "16px 18px 6px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={KEY}>TOKEN PRICE</div>
          <div style={{ fontFamily: MONO, fontSize: 26, fontWeight: 600, color: "#fdfbf7" }}>{t.price}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
          <div style={KEY}>24H</div>
          <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 600, color: t.c }}>{t.chg}</div>
        </div>
      </div>

      <div style={{ padding: "4px 8px 8px" }}>
        <Sparkline
          positionTokenAddress={t.token.positionTokenAddress}
          series={t.token.series}
          color={t.c}
          fill={t.fill}
          height={76}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 1, background: "rgba(255,255,255,0.1)" }}>
        {t.cells.map((c) => (
          <div key={c.k} style={{ padding: "12px 14px", background: "#241c46", display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "#a79bd0" }}>{c.k}</div>
            <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 500, color: "#fdfbf7" }}>{c.v}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "13px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <div style={{ width: 18, height: 18, borderRadius: "50%", background: t.accent, opacity: 0.8 }} />
          <div
            style={{
              fontFamily: MONO,
              fontSize: 11,
              color: "#a79bd0",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {t.creator}
          </div>
        </div>
        <div
          onClick={onBuy}
          className="laxu-spot-buy"
          style={{
            flex: "none",
            fontSize: 12,
            fontWeight: 700,
            color: "#fdfbf7",
            background: "#9670ff",
            padding: "8px 16px",
            borderRadius: 99,
            cursor: "pointer",
          }}
        >
          Buy in
        </div>
      </div>
    </div>
  );
}
