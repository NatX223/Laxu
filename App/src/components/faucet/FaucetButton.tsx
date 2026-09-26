"use client";

import { useEffect, useState } from "react";
import { env } from "@/lib/env";
import { useFaucet, type FaucetPhase } from "@/lib/faucet";
import { useSession } from "@/lib/session";

/**
 * "Get test funds" — testnet only. The faucet pays for everything: a new
 * embedded wallet holds no ETH, so it couldn't even mint USDG itself.
 *
 * `header` sits next to the account menu (its result shows in a small panel
 * under it); `inline` is the full-width block the trade ticket's nudge uses.
 */

const DISCLAIMER = "Testnet only, no real value";
/** Below this the wallet can't pay gas for a trade. */
export const MIN_GAS_ETH = 0.0001;

const TONES = {
  frost: { color: "#fdfbf7", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" },
  amber: { color: "#ffb765", background: "rgba(255,183,101,0.1)", border: "1px solid rgba(255,183,101,0.45)" },
} satisfies Record<string, React.CSSProperties>;

const fmtAmount = (usdg: string | null) => (usdg ? Number(usdg).toLocaleString("en-US") : "");

/** "14h 20m", "20m", "<1m". */
function countdown(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "<1m";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function Spinner() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" className="laxu-spin">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 13 9 18 20 6" />
    </svg>
  );
}

/** What the result panel (header) or line (inline) says after a claim. */
function ResultMessage({ phase, amount }: { phase: FaucetPhase; amount: string }) {
  if (phase.kind === "sent" && !phase.ethSkipped) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#5fe3a8" }}>
        <Check /> {amount} USDG and gas sent.
      </span>
    );
  }
  if (phase.kind === "sent") {
    return (
      <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#5fe3a8" }}>
          <Check /> USDG sent.
        </span>
        <span style={{ color: "#ffb765" }}>
          Gas faucet is low. You may need testnet ETH from{" "}
          {env.ethFaucetUrl ? (
            <a href={env.ethFaucetUrl} target="_blank" rel="noreferrer" style={{ color: "#ffd29c", textDecoration: "underline" }}>
              a public faucet
            </a>
          ) : (
            "a public testnet faucet"
          )}
          .
        </span>
      </span>
    );
  }
  if (phase.kind === "error") {
    return (
      <span title={phase.message} style={{ color: "#ff8a8a", cursor: "help" }}>
        Couldn&rsquo;t send test funds. Try again.
      </span>
    );
  }
  return null;
}

export default function FaucetButton({
  variant = "header",
  tone = "frost",
}: {
  variant?: "header" | "inline";
  tone?: keyof typeof TONES;
}) {
  const { ready, authenticated, user, login } = useSession();
  const { enabled, usdgAmount, status, phase, claim, dismiss, refresh } = useFaucet();
  const now = useNow(30_000);

  const nextAt = status && !status.canClaim && status.nextClaimAt ? Date.parse(status.nextClaimAt) : null;
  const cooledDown = nextAt !== null && nextAt <= now;
  // The cooldown ran out while the page was open: ask the backend again.
  useEffect(() => {
    if (cooledDown) refresh();
  }, [cooledDown, refresh]);

  if (enabled !== true || !ready) return null;

  const amount = fmtAmount(usdgAmount);
  const inline = variant === "inline";
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    fontFamily: "inherit",
    fontSize: inline ? 12.5 : 11.5,
    fontWeight: 700,
    borderRadius: 99,
    whiteSpace: "nowrap",
    padding: inline ? "10px 14px" : "7px 12px",
    cursor: "pointer",
    ...TONES[tone],
    ...(inline ? { width: "100%" } : null),
  };

  if (!authenticated) {
    return (
      <button
        type="button"
        onClick={login}
        // phones: the account menu's own Sign in is enough in a header
        className={`laxu-account-btn laxu-faucet-btn${inline ? "" : " laxu-faucet-long"}`}
        style={base}
        title={DISCLAIMER}
      >
        Sign in to get test funds
      </button>
    );
  }
  // Loading the user row or the status: nothing yet, rather than a guess.
  if (!user || !status) return null;

  const sending = phase.kind === "sending";
  const waiting = !sending && nextAt !== null && !cooledDown;

  let label: React.ReactNode;
  if (sending) {
    label = (
      <>
        <Spinner /> Sending test funds…
      </>
    );
  } else if (waiting) {
    label = <>Next claim in {countdown((nextAt as number) - now)}</>;
  } else {
    label = (
      <>
        Get test funds
        <span style={{ fontWeight: 600, opacity: 0.75 }}>
          <span className={inline ? undefined : "laxu-faucet-long"}>: {amount} USDG + gas</span>
        </span>
      </>
    );
  }

  const disabled = sending || waiting;
  const button = (
    <button
      type="button"
      onClick={() => void claim()}
      disabled={disabled}
      aria-busy={sending}
      title={waiting ? `${DISCLAIMER}. One claim every 24 hours.` : DISCLAIMER}
      className="laxu-account-btn laxu-faucet-btn"
      style={{ ...base, cursor: disabled ? "default" : "pointer", opacity: waiting ? 0.6 : 1 }}
    >
      {label}
    </button>
  );
  const showResult = phase.kind === "sent" || phase.kind === "error";

  if (inline) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {button}
        {showResult && (
          <div role="status" style={{ fontSize: 11, fontWeight: 600, lineHeight: 1.45 }}>
            <ResultMessage phase={phase} amount={amount} />
          </div>
        )}
        <div style={{ fontSize: 10.5, color: "#998dbd" }}>{DISCLAIMER}.</div>
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      {button}
      <span aria-live="polite" className="laxu-sr-only">
        {sending ? "Sending test funds" : ""}
      </span>
      {showResult && (
        <div
          role="status"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            // Same layer as the account menu.
            zIndex: 70,
            width: 260,
            maxWidth: "calc(100vw - 32px)",
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1.45,
            background: "#261e49",
            border: "1px solid rgba(255,255,255,0.14)",
            borderRadius: 12,
            boxShadow: "0 14px 40px rgba(10, 6, 28, 0.55)",
            animation: "laxu-fade 0.16s ease both",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
            <ResultMessage phase={phase} amount={amount} />
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss"
              className="laxu-info-close"
              style={{ background: "none", border: "none", padding: 0, color: "#a79bd0", cursor: "pointer", fontSize: 14, lineHeight: 1 }}
            >
              ×
            </button>
          </div>
          <div style={{ fontSize: 10.5, fontWeight: 500, color: "#998dbd" }}>{DISCLAIMER}.</div>
        </div>
      )}
    </div>
  );
}

/**
 * Trade-ticket nudge: shown while the wallet can't cover `tradeUsdg` or the
 * gas for it — or signed out, when we can't tell — and while a claim it
 * started is still reporting back.
 */
export function FaucetNudge({ tradeUsdg }: { tradeUsdg: number }) {
  const { ready, authenticated } = useSession();
  const { enabled, status, phase } = useFaucet();
  if (enabled !== true || !ready) return null;

  if (authenticated) {
    if (!status) return null;
    const low = Number(status.balances.usdg) < tradeUsdg || Number(status.balances.eth) < MIN_GAS_ETH;
    if (!low && phase.kind === "idle") return null;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 11,
        borderRadius: 12,
        background: "rgba(255,183,101,0.07)",
        border: "1px solid rgba(255,183,101,0.28)",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, color: "#fdfbf7" }}>You need test funds to trade.</div>
      <FaucetButton variant="inline" tone="amber" />
    </div>
  );
}
