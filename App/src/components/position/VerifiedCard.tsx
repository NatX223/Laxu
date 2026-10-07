"use client";

import type { PublicPosition } from "@/lib/api";
import { env } from "@/lib/env";
import { CELL_BG, HAIRLINE, MONO, Panel, PanelHead } from "./shared";
import type { TokenState } from "./onchain";

const GOOD = "#5fe3a8";
const WARN = "#ffb765";

const price = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n >= 10 ? 2 : 6 });
const amount = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 6 });

/**
 * "Verified against Perpl": the token's own size and entry next to the real
 * position on Perpl, read on-chain through `venueDrift()`. Size must match
 * exactly and the entry within 0.5% (the tolerance the token itself enforces
 * at every fill). The two drift apart by design when a buy-in or redeem is
 * smaller than one lot, so a mismatch is flagged, not hidden. Open positions only.
 */
export default function VerifiedCard({ live, chain }: { live: PublicPosition; chain: TokenState | null }) {
  const drift = chain?.drift;
  if (!chain || chain.closed || !drift) return null;

  const sizeOk = drift.venueExists && drift.ourSize === drift.venueSize;
  const entryGap = drift.ourEntry > 0 ? Math.abs(drift.ourEntry - drift.venueEntry) / drift.ourEntry : 0;
  const entryOk = drift.venueExists && entryGap <= 0.005;
  const base = live.symbol ?? "";

  // Perpl margins a position at its stated leverage: liquidation sits about 1/leverage from the entry.
  const away = 1 / live.leverage;
  const liq = live.direction === "long" ? chain.entry * (1 - away) : chain.entry * (1 + away);

  const rows = [
    {
      k: "Size",
      ours: `${amount(drift.ourSize)} ${base}`,
      theirs: drift.venueExists ? `${amount(drift.venueSize)} ${base}` : "no position",
      ok: sizeOk,
    },
    {
      k: "Entry",
      ours: price(drift.ourEntry),
      theirs: drift.venueExists ? price(drift.venueEntry) : "no position",
      ok: entryOk,
    },
  ];

  const token = live.positionTokenAddress;

  return (
    <Panel>
      <PanelHead label="VERIFIED AGAINST PERPL">
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.1em",
            padding: "3px 9px",
            borderRadius: 99,
            color: drift.verified ? "#0b3d2a" : "#3d2a08",
            background: drift.verified ? GOOD : WARN,
          }}
        >
          {drift.verified ? "✓ MATCHES" : "⚠ MISMATCH"}
        </span>
      </PanelHead>

      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr auto", gap: 1, background: HAIRLINE }}>
        {["", "THIS TOKEN", "PERPL", ""].map((h, i) => (
          <div key={i} style={{ padding: "8px 14px", background: CELL_BG, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em", color: "#a79bd0" }}>
            {h}
          </div>
        ))}
        {rows.map((r) => (
          <Row key={r.k} {...r} />
        ))}
      </div>

      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8, fontSize: 11.5, fontWeight: 500, lineHeight: 1.5, color: "#c2b6e4" }}>
        {!drift.verified && (
          <div style={{ color: WARN, fontWeight: 600 }}>
            {drift.venueExists
              ? "The token and Perpl disagree. This happens by design when a buy-in or redeem is smaller than one lot; a large gap is an alarm."
              : "Perpl shows no open position for this account right now."}
          </div>
        )}
        <div>
          Liquidation ≈ entry {live.direction === "long" ? "−" : "+"} 1/leverage ({live.leverage}×):{" "}
          <span style={{ fontFamily: MONO, color: "#fdfbf7" }}>≈ {price(liq)}</span>
        </div>
        <div style={{ color: "#8f85bd" }}>
          Perpl account #{chain.venueAccountId} ·{" "}
          {env.explorerUrl && (
            <a
              href={`${env.explorerUrl}/address/${token}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: "#ffd29c", textDecoration: "underline" }}
            >
              token on MonadVision
            </a>
          )}
        </div>
      </div>
    </Panel>
  );
}

function Row({ k, ours, theirs, ok }: { k: string; ours: string; theirs: string; ok: boolean }) {
  const cell: React.CSSProperties = { padding: "11px 14px", background: CELL_BG, fontFamily: MONO, fontSize: 12.5, color: "#fdfbf7" };
  return (
    <>
      <div style={{ ...cell, fontFamily: "inherit", fontSize: 11, fontWeight: 600, color: "#a79bd0" }}>{k}</div>
      <div style={cell}>{ours}</div>
      <div style={cell}>{theirs}</div>
      <div style={{ ...cell, fontWeight: 700, color: ok ? GOOD : WARN }} aria-label={ok ? "matches" : "does not match"}>
        {ok ? "✓" : "⚠"}
      </div>
    </>
  );
}
