"use client";

import { useEffect, useState } from "react";
import { getFunding, type FundingSummary } from "@/lib/api";
import { MONO, Panel, PanelHead } from "./shared";

const GOOD = "#5fe3a8";
const BAD = "#ff8f7d";
const MUTED = "#8f85bd";

const pct = (n: number, digits: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}%`;
const every = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600}h` : `${Math.round(sec / 60)} min`);

/**
 * "Funding": Perpl's current funding rate for this market (its newest funding
 * event) and what it means for this position's side. Perpl's convention: a
 * positive rate means longs pay shorts. Open positions only; a missing rate
 * shows a dash, never a guess.
 */
export default function FundingCard({ symbol, direction }: { symbol: string; direction: "long" | "short" }) {
  const [data, setData] = useState<FundingSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getFunding(symbol, 24)
      .then((next) => !cancelled && setData(next))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const current = data?.current ?? null;
  const rate = current?.ratePct ?? null;
  const pays = rate === null || rate === 0 ? null : (rate > 0) === (direction === "long");
  const avg24 =
    data && data.history.length > 0 ? data.history.reduce((sum, p) => sum + p.ratePct, 0) / data.history.length : null;

  return (
    <Panel>
      <PanelHead label="FUNDING ON PERPL">
        {current?.estimatedTime && <span style={{ fontSize: 10.5, fontWeight: 600, color: MUTED }}>next rate, time estimated</span>}
      </PanelHead>
      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8, fontSize: 12, fontWeight: 500, lineHeight: 1.5, color: "#c2b6e4" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 14px" }}>
          <span>Current rate</span>
          <span style={{ fontFamily: MONO, fontSize: 14, color: rate === null ? "#fdfbf7" : rate >= 0 ? GOOD : BAD }}>
            {rate === null ? (failed ? "unavailable" : data ? "—" : "…") : pct(rate, 4)}
          </span>
          {current && data && (
            <span style={{ color: MUTED }}>
              every {every(data.intervalSec)} · ≈ {pct(current.annualizedPct, 1)} a year
              {avg24 !== null && ` · 24h avg ${pct(avg24, 4)}`}
            </span>
          )}
        </div>
        <div>
          Positive rate: longs pay shorts; negative: shorts pay longs.
          {pays !== null && (
            <>
              {" "}
              At this rate this {direction} position{" "}
              <strong style={{ color: pays ? BAD : GOOD }}>{pays ? "pays" : "receives"}</strong> funding.
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}
