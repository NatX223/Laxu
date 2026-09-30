"use client";

import Link from "next/link";
import type { OpenRequestStatus } from "@/lib/actions";
import { env } from "@/lib/env";
import { money } from "./data";
import type { OpenTrade } from "./openTrade";
import { MONO, SERIF } from "./shared";

/**
 * The open-position stepper: one row per backend status, driven by
 * `GET /positions/open/:id` every 3s. The step names are the exact
 * `OpenRequestStatus` values from Backend/src/services/openPosition.ts.
 */

type StepKey = Extract<OpenRequestStatus, "awaiting_payment" | "payment_received" | "deposited" | "order_filled" | "minted">;

const STEPS: StepKey[] = ["awaiting_payment", "payment_received", "deposited", "order_filled", "minted"];

const RANK: Record<OpenRequestStatus, number> = {
  awaiting_payment: 0,
  payment_received: 1,
  deposited: 2,
  order_filled: 3,
  minted: 4,
  refunding: -1,
  refunded: -1,
  failed: -1,
};

function stepLabel(step: StepKey, entry: string | null): string {
  switch (step) {
    case "awaiting_payment":
      return "Confirm the USDG payment in your wallet";
    case "payment_received":
      return "Payment received";
    case "deposited":
      return "Funding your trade on Arcus";
    case "order_filled":
      return entry ? `Trade filled at ${money(Number(entry), Number(entry) >= 10 ? 2 : 4)}` : "Placing your trade";
    case "minted":
      return "Position token minted";
  }
}

const txLink = (hash: string) => (env.explorerUrl ? `${env.explorerUrl.replace(/\/$/, "")}/tx/${hash}` : null);

export default function OpenProgress({ open }: { open: OpenTrade }) {
  const { phase, dismiss, abandon } = open;
  if (phase.kind === "idle") return null;

  const request = phase.kind === "tracking" ? phase.request : null;
  const status: OpenRequestStatus = request?.status ?? "awaiting_payment";
  const current = RANK[status];
  const done = status === "minted" || status === "refunded" || status === "failed";
  const canClose = phase.kind === "error" || done;
  // Resumed after a refresh with no payment on record: it may never come.
  const unpaidResume = phase.kind === "tracking" && request?.status === "awaiting_payment" && !request.paymentTxHash;

  let title = "Opening your position";
  if (phase.kind === "error") title = "Trade not opened";
  else if (status === "minted") title = "Position open";
  else if (status === "refunding" || status === "refunded") title = "Trade couldn’t be opened";
  else if (status === "failed") title = "Something went wrong";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="laxu-open-title"
      onClick={canClose ? dismiss : undefined}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(14,10,32,0.62)",
        backdropFilter: "blur(10px)",
        animation: "laxu-fade 0.16s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 420,
          borderRadius: 20,
          overflow: "hidden",
          background: "rgba(36,28,70,0.92)",
          border: "1px solid rgba(255,255,255,0.18)",
          backdropFilter: "blur(26px)",
          boxShadow: "0 30px 70px rgba(8,5,24,0.6)",
          animation: "laxu-rise 0.2s ease",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 3,
            padding: "16px 18px",
            background: "linear-gradient(90deg, rgba(150,112,255,0.4), rgba(255,183,101,0.16))",
            borderBottom: "1px solid rgba(255,255,255,0.12)",
          }}
        >
          <div id="laxu-open-title" style={{ fontFamily: SERIF, fontSize: 21, lineHeight: 1.1, color: "#fdfbf7" }}>
            {title}
          </div>
          {request && (
            <div style={{ fontSize: 11.5, fontWeight: 500, color: "#d5c6ff" }}>
              {request.symbol ?? "Position"} {request.direction}, {request.leverage}&times; &middot;{" "}
              {money(Number(request.amount) / 1e6, 2)} USDG
            </div>
          )}
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          {phase.kind === "error" ? (
            <div role="alert" style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.5, color: "#ffb4a8" }}>
              {phase.message}
              <div style={{ fontSize: 11.5, fontWeight: 500, color: "#c2b6e4", paddingTop: 6 }}>No USDG was taken.</div>
            </div>
          ) : phase.kind === "reserving" ? (
            <Row state="active" label="Reserving a trading slot" />
          ) : current >= 0 ? (
            <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
              {STEPS.map((step, i) => {
                // In "paying" the transfer is mid-flight: step 0 is the live one.
                const rank = phase.kind === "paying" ? 0 : current;
                const state = i < rank || (i === rank && step === "minted") ? "done" : i === rank ? "active" : "todo";
                const label =
                  step === "awaiting_payment" && phase.kind === "paying" && phase.sent
                    ? "Payment sent, waiting for confirmation"
                    : stepLabel(step, request?.entryPrice ?? null);
                return <Row key={step} state={state} label={label} />;
              })}
            </ol>
          ) : (
            <div role="alert" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13, lineHeight: 1.5 }}>
              {status === "failed" ? (
                <>
                  <div style={{ fontWeight: 600, color: "#ffb4a8" }}>Something went wrong{request?.error ? `: ${request.error}` : "."}</div>
                  {request?.paymentTxHash && (
                    <div style={{ color: "#c2b6e4" }}>Your USDG will be refunded to your wallet.</div>
                  )}
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 600, color: "#ffd9a0" }}>
                    {status === "refunding"
                      ? "Trade couldn’t be opened. Refunding your USDG…"
                      : "Trade couldn’t be opened, so your USDG was refunded."}
                  </div>
                  {request?.error && <div style={{ color: "#c2b6e4" }}>Reason: {request.error}</div>}
                  {request?.refundTxHash && (
                    <TxLink hash={request.refundTxHash} label="Refund transaction" />
                  )}
                </>
              )}
            </div>
          )}

          {phase.kind === "tracking" && phase.reconnecting && !done && (
            <div role="status" style={{ fontSize: 11.5, fontWeight: 600, color: "#ffb765" }}>
              Connection lost. Retrying&hellip; your trade continues on the server.
            </div>
          )}

          {status === "minted" && request?.positionTokenAddress && (
            <Link
              href={`/position/${request.positionTokenAddress}`}
              style={{ ...BUTTON, color: "#1c1638", background: "linear-gradient(90deg, #b99bff, #ffc98a)", textDecoration: "none" }}
            >
              View position
            </Link>
          )}

          {unpaidResume && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 11.5, lineHeight: 1.5, color: "#c2b6e4" }}>
                No payment recorded yet. If you didn&rsquo;t confirm it, this request expires on its own and nothing is taken.
              </div>
              <button type="button" onClick={abandon} style={{ ...BUTTON, ...SUBTLE }}>
                Stop waiting
              </button>
            </div>
          )}

          {canClose && (
            <button type="button" onClick={dismiss} style={{ ...BUTTON, ...SUBTLE }}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const BUTTON: React.CSSProperties = {
  display: "block",
  textAlign: "center",
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 700,
  padding: 12,
  borderRadius: 99,
  cursor: "pointer",
  border: "none",
};

const SUBTLE: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#fdfbf7",
  background: "rgba(255,255,255,0.06)",
};

function TxLink({ hash, label }: { hash: string; label: string }) {
  const href = txLink(hash);
  const short = `${hash.slice(0, 10)}…${hash.slice(-6)}`;
  return (
    <div style={{ fontFamily: MONO, fontSize: 11.5, color: "#d5c6ff" }}>
      {label}:{" "}
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" style={{ color: "#ffd29c", textDecoration: "underline" }}>
          {short}
        </a>
      ) : (
        short
      )}
    </div>
  );
}

function Row({ state, label }: { state: "done" | "active" | "todo"; label: string }) {
  const color = state === "done" ? "#5fe3a8" : state === "active" ? "#fdfbf7" : "#7b719e";
  return (
    <li style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, fontWeight: state === "todo" ? 500 : 600, color }}>
      <span style={{ width: 16, display: "inline-flex", justifyContent: "center" }} aria-hidden="true">
        {state === "done" ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 13 9 18 20 6" />
          </svg>
        ) : state === "active" ? (
          <svg width="14" height="14" viewBox="0 0 24 24" className="laxu-spin">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
            <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        ) : (
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />
        )}
      </span>
      <span>
        {label}
        <span className="laxu-sr-only">{state === "done" ? " (done)" : state === "active" ? " (in progress)" : ""}</span>
      </span>
    </li>
  );
}
