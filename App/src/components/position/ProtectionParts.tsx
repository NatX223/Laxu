"use client";

import { formatUnits, type Address } from "viem";
import type { ConnectedWallet } from "@privy-io/react-auth";
import type { LendingState } from "@/lib/actions";
import { env } from "@/lib/env";
import type { FriendlyError } from "@/lib/protection";
import { MONO } from "./shared";

/** Small pieces shared by the Protect-this-loan card, its setup panel and its event list. */

/** Everything the setup panel and the card's flows need to know about this wallet and pool. */
export type Ctx = {
  account: Address;
  wallet: ConnectedWallet;
  pool: Address;
  assetAddress: Address;
  decimals: number;
  symbol: string;
  /** The server's key quorum id, from GET /protection. */
  signerId: string;
  /** PROTECTION_MAX_SPEND_CAP in base units, from GET /protection (null before it has loaded). */
  cap: bigint | null;
  lending: LendingState;
  /** The wallet's MON in wei (it pays the gas), or null if unknown. */
  monWei: bigint | null;
};

/** Below this the wallet may not cover a repay's gas: show the warning. 0.01 MON. */
export const MON_LOW_WEI = BigInt("10000000000000000");

export const fmt = (amount: bigint, decimals: number, dp = 2) =>
  Number(formatUnits(amount, decimals)).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export const txLink = (hash: string) => (env.explorerUrl ? `${env.explorerUrl.replace(/\/$/, "")}/tx/${hash}` : null);

export type StepStatus = "pending" | "active" | "done" | "failed";
export type Step = { key: "signer" | "allowance" | "activate" | "stop"; label: string; status: StepStatus; privy?: boolean };

const STATUS_WORD: Record<StepStatus, string> = { pending: "waiting", active: "in progress", done: "done", failed: "failed" };

/** One row per step. The status is written out as a word as well as shown as a mark, so it never relies on colour. */
export function Steps({ steps, label = "Steps" }: { steps: Step[]; label?: string }) {
  return (
    <ol aria-label={label} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      {steps.map((step, i) => {
        const color = { done: "#5fe3a8", active: "#ffd29c", failed: "#ff8a8a", pending: "#6f6596" }[step.status];
        const mark = { done: "✓", active: "…", failed: "✕", pending: String(i + 1) }[step.status];
        return (
          <li
            key={step.key}
            aria-current={step.status === "active" ? "step" : undefined}
            style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 11.5, fontWeight: 600, color: step.status === "pending" ? "#8c80b8" : "#fdfbf7" }}
          >
            <span
              aria-hidden
              style={{ width: 18, height: 18, flex: "none", borderRadius: 99, display: "grid", placeItems: "center", fontFamily: MONO, fontSize: 10, border: `1px solid ${color}`, color }}
            >
              {mark}
            </span>
            <span>
              {step.label}
              {step.privy && <span style={{ fontSize: 10, fontWeight: 600, color: "#a79bd0" }}> · Powered by Privy</span>}
            </span>
            <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 600, color }}>{STATUS_WORD[step.status]}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function Banner({ children, tone = "warn" }: { children: React.ReactNode; tone?: "warn" | "info" }) {
  const warn = tone === "warn";
  return (
    <div
      role="status"
      style={{
        fontSize: 11.5,
        fontWeight: 600,
        lineHeight: 1.45,
        padding: "9px 11px",
        borderRadius: 10,
        color: warn ? "#ffd29c" : "#c2b6e4",
        background: warn ? "rgba(255,181,101,0.1)" : "rgba(255,255,255,0.05)",
        border: `1px solid ${warn ? "rgba(255,181,101,0.35)" : "rgba(255,255,255,0.14)"}`,
      }}
    >
      {children}
    </div>
  );
}

/** A cancelled prompt is neutral grey, not red: nothing went wrong. */
export function ErrorLine({ error }: { error: FriendlyError | null }) {
  if (!error) return null;
  const neutral = error.tone === "neutral";
  return (
    <div role={neutral ? "status" : "alert"} style={{ fontSize: 11.5, fontWeight: 600, lineHeight: 1.45, color: neutral ? "#c2b6e4" : "#ffb4a8" }}>
      {error.text}
    </div>
  );
}

/** The two-layers note and the Privy label. Shown in every state except "not eligible". */
export function SafetyNote() {
  return (
    <div style={{ fontSize: 10.5, lineHeight: 1.5, color: "#a79bd0" }}>
      Two safety layers: Privy&apos;s policy limits what Laxu can call; your spending limit limits how much it can ever spend.{" "}
      <span style={{ fontWeight: 700, letterSpacing: "0.04em", color: "#c2b6e4" }}>Powered by Privy</span>
    </div>
  );
}

/** What protection cannot do. `lowMon` raises the gas warning to a banner with a way to get MON. */
export function Warnings({ symbol, lowMon }: { symbol: string; lowMon: boolean }) {
  return (
    <>
      {lowMon && (
        <Banner>
          Your wallet is low on MON, which pays the gas for each repay.{" "}
          {env.monFaucetUrl ? (
            <a href={env.monFaucetUrl} target="_blank" rel="noreferrer" style={{ color: "#ffd29c" }}>
              Get test MON ↗
            </a>
          ) : (
            "Use the faucet to top it up."
          )}
        </Banner>
      )}
      <ul style={{ margin: 0, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 4, fontSize: 11, lineHeight: 1.45, color: "#c2b6e4" }}>
        <li>
          Needs {symbol} in your wallet. If your wallet is empty, protection cannot act.
        </li>
        <li>Needs a little MON in your wallet for gas. Laxu&apos;s repay is sent from your wallet, so your wallet pays the fee.</li>
        <li>A very fast market move can still liquidate you between checks.</li>
      </ul>
    </>
  );
}

/** The consent text, in plain words, with the user's own numbers. Always shown directly above the button that grants anything. */
export function Consent({ trigger, perCall, total, symbol, decimals }: { trigger: string; perCall: bigint | null; total: bigint | null; symbol: string; decimals: number }) {
  return (
    <div style={{ background: "#241c46", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 10, padding: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0", marginBottom: 6 }}>WHAT YOU ARE ALLOWING</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: "#fdfbf7" }}>
        Laxu will be allowed to call <code style={{ fontFamily: MONO }}>repay</code> on this loan&apos;s pool from your wallet, only when your health drops to{" "}
        <b>{trigger}</b>, for at most <b>{perCall === null ? "…" : `${fmt(perCall, decimals)} ${symbol}`}</b> per call and{" "}
        <b>{total === null ? "…" : `${fmt(total, decimals)} ${symbol}`}</b> in total. It cannot send your funds anywhere else. You can turn this off at any time.
      </div>
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  hint,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  hint?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" }}>{label}</span>
        <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600, color: "#fdfbf7" }}>
          {value.toFixed(2)} {hint && <span style={{ fontSize: 10.5, fontWeight: 500, color: "#a79bd0" }}>{hint}</span>}
        </span>
      </div>
      <input
        type="range"
        aria-label={label.toLowerCase()}
        min={min}
        max={max}
        step={0.05}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Math.round(Number(e.target.value) * 100) / 100)}
        style={{ width: "100%", accentColor: "#9670ff" }}
      />
    </div>
  );
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** A typed amount in the asset's base units; null when blank, malformed or zero. */
export function parseAmount(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const units = BigInt(whole) * BigInt(10) ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals));
  return units > BigInt(0) ? units : null;
}

export function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
