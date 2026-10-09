"use client";

import { useEffect, useState } from "react";
import { getVenueFills, type VenueFill, type VenueFills } from "@/lib/api";
import { useAsset } from "@/lib/asset";
import { env } from "@/lib/env";
import { laxuFeeLabel, useLaxuFeePct } from "@/lib/laxuFee";
import { CELL_BG, HAIRLINE, MONO, Panel, PanelHead } from "./shared";

const GOOD = "#5fe3a8";
const BAD = "#ff8f7d";
const WARN = "#ffb765";
const MUTED = "#8f85bd";

const time = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : "—";
const num = (s: string) => Number(s).toLocaleString("en-US", { maximumFractionDigits: 8 });
const usd = (s: string | null) =>
  s === null ? "—" : "$" + Number(s).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/**
 * "Fills on Perpl": every fill of this position, read from Perpl's own history
 * API by the backend, with the transaction on MonadVision. The proof that the
 * position really traded on Perpl. Display only; works for open and closed positions.
 */
export default function FillsCard({ token, base, refreshKey }: { token: string; base: string; refreshKey?: number }) {
  const asset = useAsset();
  const laxuFeePct = useLaxuFeePct();
  const [data, setData] = useState<VenueFills | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getVenueFills(token)
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Couldn't load fills from Perpl");
      });
    return () => {
      cancelled = true;
    };
  }, [token, refreshKey, attempt]);

  const retry = () => {
    setError(null);
    setData(null);
    setAttempt((n) => n + 1);
  };

  const fills = data?.fills ?? [];
  const showBuilder = fills.some((f) => f.builderFeeHuman);
  const headers = ["TIME", "SIDE", "SIZE", "PRICE", `FEE (${asset.symbol})`, ...(showBuilder ? ["LAXU FEE"] : []), "TX"];

  return (
    <Panel>
      <PanelHead label="FILLS ON PERPL">
        {data && data.fills.length > 0 && (
          <span style={{ fontSize: 10.5, fontWeight: 600, color: MUTED }}>
            {data.fills.length} fill{data.fills.length === 1 ? "" : "s"} · account #{data.accountId}
          </span>
        )}
      </PanelHead>

      {error ? (
        <div role="alert" style={{ padding: "16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 12, color: WARN }}>
          <span>{error}</span>
          <button
            type="button"
            onClick={retry}
            style={{ padding: "6px 14px", borderRadius: 99, border: "1px solid rgba(255,255,255,0.2)", background: "transparent", color: "#fdfbf7", fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}
          >
            Retry
          </button>
        </div>
      ) : !data ? (
        <div aria-busy="true" aria-label="Loading fills" style={{ display: "flex", flexDirection: "column", gap: 1, background: HAIRLINE }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ height: 38, background: CELL_BG, animation: "laxu-pulse 1.4s ease-in-out infinite", animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
      ) : fills.length === 0 ? (
        <div style={{ padding: "18px 16px", fontSize: 12.5, fontWeight: 500, color: "#c2b6e4" }}>No fills yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div
            role="table"
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${headers.length - 1}, auto) 1fr`,
              gap: 1,
              background: HAIRLINE,
              minWidth: 560,
            }}
          >
            {headers.map((h) => (
              <div key={h} role="columnheader" style={{ padding: "8px 12px", background: CELL_BG, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em", color: "#a79bd0" }}>
                {h}
              </div>
            ))}
            {fills.map((f) => (
              <FillRow key={f.fillId} fill={f} base={base} showBuilder={showBuilder} />
            ))}
          </div>
        </div>
      )}

      <div style={{ padding: "10px 16px 12px", display: "flex", flexDirection: "column", gap: 6, fontSize: 11, fontWeight: 500, lineHeight: 1.5, color: MUTED }}>
        {data?.realisedFunding != null && Number(data.realisedFunding) !== 0 && (
          <div>
            Funding realised on Perpl:{" "}
            <span style={{ fontFamily: MONO, color: Number(data.realisedFunding) > 0 ? GOOD : BAD }}>
              {Number(data.realisedFunding) > 0 ? "+" : "−"}
              {num(String(Math.abs(Number(data.realisedFunding))))} {asset.symbol}
            </span>{" "}
            ({Number(data.realisedFunding) > 0 ? "received" : "paid"}; Perpl books it when the position size changes or closes).
          </div>
        )}
        {data?.stale && <div style={{ color: WARN }}>Perpl is busy right now; showing the last copy fetched at {time(data.fetchedAt)}.</div>}
        {data?.truncated && <div style={{ color: WARN }}>History is long; the oldest fills may be missing.</div>}
        {laxuFeePct > 0 && (
          <div>
            Laxu fee: {laxuFeeLabel(laxuFeePct)} of each order, included in the fee column (Laxu fee column shows its part).
          </div>
        )}
        <div>Straight from Perpl&apos;s API. Order history can lag up to ~25 seconds.</div>
      </div>
    </Panel>
  );
}

function FillRow({ fill, base, showBuilder }: { fill: VenueFill; base: string; showBuilder: boolean }) {
  const cell: React.CSSProperties = { padding: "10px 12px", background: CELL_BG, fontFamily: MONO, fontSize: 12, color: "#fdfbf7", whiteSpace: "nowrap" };
  const fee = Number(fill.feeHuman);
  return (
    <>
      <div role="cell" style={{ ...cell, color: "#c2b6e4" }}>{time(fill.time)}</div>
      <div role="cell" style={{ ...cell, fontFamily: "inherit", fontWeight: 700, color: fill.side === "buy" ? GOOD : BAD }}>
        {fill.side === "buy" ? "Buy" : "Sell"} <span style={{ fontWeight: 500, color: MUTED }}>· {fill.action}</span>
      </div>
      <div role="cell" style={cell}>
        {num(fill.sizeHuman)} {base}
      </div>
      <div role="cell" style={cell}>{usd(fill.priceHuman)}</div>
      <div role="cell" style={cell} title={fill.liquiditySide === "maker" ? "Maker" : fill.liquiditySide === "taker" ? "Taker" : undefined}>
        {fee < 0 ? `−${num(String(-fee))} rebate` : num(fill.feeHuman)}
      </div>
      {showBuilder && <div role="cell" style={cell}>{fill.builderFeeHuman ? num(fill.builderFeeHuman) : "—"}</div>}
      <div role="cell" style={cell}>
        {fill.txHash && env.explorerUrl ? (
          <a href={`${env.explorerUrl}/tx/${fill.txHash}`} target="_blank" rel="noreferrer" style={{ color: "#ffd29c", textDecoration: "underline" }}>
            {fill.txHash.slice(0, 8)}…{fill.txHash.slice(-4)}
          </a>
        ) : (
          <span style={{ color: MUTED }}>—</span>
        )}
      </div>
    </>
  );
}
