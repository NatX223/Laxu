"use client";

import { useAsset } from "@/lib/asset";
import { useRawMarketStates } from "@/lib/perplMarketData";
import { useTokenCounts } from "@/lib/tokenCounts";
import { cat, money } from "./data";
import type { MarketView } from "./derive";
import type { TradeEngine } from "./engine";
import { MONO } from "./shared";
import { countdownLabel, statsFor, useNow } from "./stats";

/** Mark price plus the six market stats, split by a hairline rule. Every figure is Perpl's, or a dash. */
export default function StatsBar({ engine, mkt }: { engine: TradeEngine; mkt: MarketView }) {
  const { st } = engine;
  const { mark, open, chg, chgColor, dp } = mkt;
  // The countdown ticks here, not in the screen: only this bar re-renders each second.
  const now = useNow(1000);
  const raw = useRawMarketStates();
  const { decimals } = useAsset();
  const counts = useTokenCounts();
  const stats = statsFor(cat(st.market).live, { raw, decimals, counts }, now);

  const known = mark !== null && open !== null;
  const fundingColor = stats.fundingPositive === null ? "#e3ddf4" : stats.fundingPositive ? "#2fd18c" : "#ff8f7d";

  const cells = [
    {
      k: "24H CHANGE",
      v: known ? (chg >= 0 ? "+" : "−") + money(Math.abs(mark - open), dp) : "—",
      c: known ? chgColor : "#e3ddf4",
    },
    { k: `FUNDING / ${stats.fundingInterval}`, v: stats.funding, c: fundingColor },
    { k: "NEXT FUNDING", v: countdownLabel(stats.nextFundingIn), c: "#e3ddf4" },
    { k: "OPEN INTEREST", v: stats.openInterest, c: "#e3ddf4" },
    { k: "24H VOLUME", v: stats.volume, c: "#e3ddf4" },
    { k: "LAXU TOKENS", v: stats.tokens, c: "#ffb765" },
  ];

  return (
    <div
      className="laxu-stats"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 0,
        background: "rgba(255,255,255,0.045)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 14,
        padding: "12px 16px",
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingRight: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" }}>MARK</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 24,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: known ? chgColor : "#e3ddf4",
            }}
          >
            {mark === null ? "—" : money(mark, dp)}
          </div>
          {known && (
            <div style={{ fontSize: 13, fontWeight: 700, color: chgColor }}>
              {(chg >= 0 ? "+" : "") + chg.toFixed(2)}%
            </div>
          )}
        </div>
      </div>

      <div className="laxu-stats-divider" style={{ width: 1, height: 34, background: "rgba(255,255,255,0.12)" }} />

      {cells.map((s) => (
        <div key={s.k} className="laxu-stats-cell" style={{ display: "flex", flexDirection: "column", gap: 3, padding: "0 12px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0", whiteSpace: "nowrap" }}>
            {s.k}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", color: s.c }}>{s.v}</div>
        </div>
      ))}
    </div>
  );
}
