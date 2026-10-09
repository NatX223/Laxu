"use client";

import { useCallback, useEffect, useState } from "react";
import { useSigners } from "@privy-io/react-auth";
import { formatUnits, type Address } from "viem";
import { readLendingState, setAllowance, txErrorMessage, type LendingState } from "@/lib/actions";
import { ApiError, type PublicPosition } from "@/lib/api";
import { useAsset } from "@/lib/asset";
import { env } from "@/lib/env";
import {
  activateProtection,
  createProtection,
  getProtection,
  previewRepay,
  turnOffProtection,
  type CreatedProtection,
  type ProtectionEvent,
  type ProtectionList,
  type ProtectionRule,
} from "@/lib/protection";
import { useSession } from "@/lib/session";
import { getWalletClient } from "@/lib/walletClient";
import { Action, Note } from "./HolderActions";
import { CELL_BG, HAIRLINE, MONO, Panel, PanelHead } from "./shared";

/**
 * "Protect this loan": auto-repay from the user's own Privy embedded wallet.
 *
 * Two safety layers, both chosen here and both visible: a Privy policy limits WHAT Laxu may call
 * (`repay` on this pool, up to a per-call cap, nothing else) and the ERC-20 allowance limits HOW MUCH
 * it can ever spend. Setup asks Privy for the signer (step 1) and the user's wallet for the allowance
 * (step 2); the backend then checks both itself before it believes either.
 */

const POLL_MS = 15_000;
const TRIGGER_MIN = 1.05;
const TRIGGER_MAX = 3;
const TARGET_MAX = 5;
const GAP = 0.1;

const fmt = (amount: bigint, decimals: number, dp = 2) =>
  Number(formatUnits(amount, decimals)).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

const txLink = (hash: string) => (env.explorerUrl ? `${env.explorerUrl.replace(/\/$/, "")}/tx/${hash}` : null);

type StepStatus = "pending" | "active" | "done" | "failed";
type Step = { key: string; label: string; status: StepStatus; privy?: boolean };

/** What an interrupted setup still has to do, kept so "Continue" resumes instead of starting over. */
type Setup = { created: CreatedProtection; signerDone: boolean; allowanceDone: boolean };

export default function ProtectionCard(props: { live: PublicPosition; refreshKey: number; onDone: (message: string) => void }) {
  // Without an app id there is no PrivyProvider, and useSigners would throw.
  if (!env.privyAppId) return null;
  return <Card {...props} />;
}

function Card({ live, refreshKey, onDone }: { live: PublicPosition; refreshKey: number; onDone: (message: string) => void }) {
  const { wallet } = useSession();
  const { addSigners, removeSigners } = useSigners();
  const { symbol } = useAsset();
  const account = wallet?.address as Address | undefined;
  const token = live.positionTokenAddress as Address;
  const pool = live.lendingPoolAddress as Address | null;

  const [list, setList] = useState<ProtectionList | null>(null);
  const [lending, setLending] = useState<LendingState | null>(null);
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState(1.15);
  const [target, setTarget] = useState(1.3);
  const [spendText, setSpendText] = useState("50");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The rules from the backend and the pool's figures from the chain; either may fail without hiding the other. */
  const read = useCallback(async () => {
    if (!account || !pool) return null;
    const [rules, state] = await Promise.allSettled([getProtection(), readLendingState(pool, token, account)]);
    return {
      rules: rules.status === "fulfilled" ? rules.value : null,
      state: state.status === "fulfilled" ? state.value : null,
    };
  }, [account, pool, token]);

  const apply = useCallback((result: Awaited<ReturnType<typeof read>>) => {
    if (!result) return;
    if (result.rules) setList(result.rules);
    if (result.state) setLending(result.state);
  }, []);

  const load = useCallback(async () => apply(await read()), [apply, read]);

  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      read().then((result) => {
        if (!cancelled) apply(result);
      });
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [read, apply, refreshKey]);

  if (!wallet || !account || !pool || !lending) return null;
  const rule = list?.rules.find((r) => r.poolAddress === pool.toLowerCase()) ?? null;
  const holds = lending.walletShares > BigInt(0) || lending.collateralShares > BigInt(0) || lending.debt > BigInt(0);
  if (!holds && !rule?.enabled) return null;

  const { decimals } = lending;
  const embedded = wallet.walletClientType === "privy";

  // --- steps -------------------------------------------------------------------

  const mark = (index: number, status: StepStatus) =>
    setSteps((current) => current?.map((s, i) => (i === index ? { ...s, status } : s)) ?? null);

  /** Runs the three setup steps from wherever they stopped; each success is remembered. */
  const runSetup = async (start: Setup) => {
    const state = { ...start };
    setSetup(state);
    setSteps([
      { key: "signer", label: "Allow Laxu to repay", status: state.signerDone ? "done" : "pending", privy: true },
      { key: "allowance", label: "Approve spending limit", status: state.allowanceDone ? "done" : "pending" },
      { key: "activate", label: "Turn protection on", status: "pending" },
    ]);
    let index = 0;
    try {
      if (!state.signerDone) {
        index = 0;
        mark(0, "active");
        // Privy's own prompt, with the policy the backend just created.
        await addSigners({ address: account, signers: state.created.signerConfig.signers });
        state.signerDone = true;
        setSetup({ ...state });
        mark(0, "done");
      }
      if (!state.allowanceDone) {
        index = 1;
        mark(1, "active");
        const client = await getWalletClient(wallet);
        const { token: asset, spender, amount } = state.created.allowanceToApprove;
        await setAllowance(client, asset as Address, spender as Address, BigInt(amount));
        state.allowanceDone = true;
        setSetup({ ...state });
        mark(1, "done");
      }
      index = 2;
      mark(2, "active");
      // Success is shown only when the backend, having checked both itself, says so.
      await activateProtection(state.created.ruleId);
      mark(2, "done");
      setSetup(null);
      setSteps(null);
      setOpen(false);
      onDone("Loan protection is on");
    } catch (err) {
      mark(index, "failed");
      setError(errorText(err));
    } finally {
      await load();
    }
  };

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      if (setup) {
        await runSetup(setup);
      } else {
        const created = await createProtection({
          pool,
          triggerHealth: trigger.toFixed(2),
          targetHealth: target.toFixed(2),
          maxSpend: spendText.trim(),
        });
        await runSetup({ created, signerDone: false, allowanceDone: false });
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  /** Resume a rule that was created but never switched on. */
  const resume = (r: ProtectionRule) => {
    if (!r.policyId || !list) return;
    void (async () => {
      setBusy(true);
      setError(null);
      await runSetup({
        created: {
          ruleId: r.id,
          policyId: r.policyId as string,
          signerConfig: { address: account, signers: [{ signerId: list.signerId, policyIds: [r.policyId as string] }] },
          allowanceToApprove: { token: env.assetAddress, spender: pool, amount: r.maxSpend, amountHuman: formatUnits(BigInt(r.maxSpend), decimals) },
          maxPerCall: r.maxPerCall,
        },
        signerDone: r.signerPresent === true,
        allowanceDone: r.allowance !== null && r.allowance !== undefined && BigInt(r.allowance) === BigInt(r.maxSpend),
      });
      setBusy(false);
    })();
  };

  /** Turn off: stop the worker first (it only reads the rule), then take back the two permissions. */
  const turnOff = async (r: ProtectionRule, alreadyOff = false) => {
    setBusy(true);
    setError(null);
    const all: Step[] = [
      { key: "stop", label: "Stop Laxu acting", status: alreadyOff ? "done" : "pending" },
      { key: "signer", label: "Remove Laxu's permission", status: "pending", privy: true },
      { key: "allowance", label: "Set the spending limit to 0", status: "pending" },
    ];
    setSteps(all);
    let index = 0;
    try {
      if (!alreadyOff) {
        mark(0, "active");
        await turnOffProtection(r.id);
        mark(0, "done");
      }
      index = 1;
      mark(1, "active");
      await removeSigners({ address: account });
      mark(1, "done");
      index = 2;
      mark(2, "active");
      const client = await getWalletClient(wallet);
      await setAllowance(client, env.assetAddress as Address, pool, BigInt(0));
      mark(2, "done");
      setSteps(null);
      onDone("Loan protection is off");
    } catch (err) {
      mark(index, "failed");
      setError(
        index === 0
          ? errorText(err)
          : `Protection is off and Laxu will not act, but its permission is still on your wallet. ${errorText(err)}`,
      );
    } finally {
      setBusy(false);
      await load();
    }
  };

  // --- derived for the setup form -------------------------------------------------

  const spend = parseSpend(spendText, decimals);
  const perCall = spend === null ? null : spend / BigInt(2);
  const preview =
    spend === null
      ? null
      : previewRepay({
          debt: lending.debt,
          collateralValue: lending.collateralValue,
          thresholdBps: lending.liquidationThresholdBps,
          targetHealth: target.toFixed(2),
          maxSpend: spend,
          walletBalance: lending.walletAsset,
        });
  const hf = lending.healthFactor === null ? null : Number(formatUnits(lending.healthFactor, 18));
  const leftover =
    rule && !rule.enabled && (rule.signerPresent === true || (rule.allowance != null && BigInt(rule.allowance) > BigInt(0)));

  // --- render -------------------------------------------------------------------

  if (!embedded) {
    return (
      <Shell on={false}>
        <Note>Loan protection needs a Laxu wallet created with email sign-in.</Note>
      </Shell>
    );
  }

  if (rule?.enabled) {
    return (
      <Shell on>
        <OnView rule={rule} decimals={decimals} symbol={symbol} />
        {steps && <Steps steps={steps} />}
        {error && <ErrorLine>{error}</ErrorLine>}
        <PrivyCaption>
          Turning off asks Privy to remove Laxu&apos;s permission, then sets the spending limit to 0.
        </PrivyCaption>
        <Action label={busy ? "Working…" : "Turn off"} subtle disabled={busy} onClick={() => void turnOff(rule)} />
        <Warnings />
      </Shell>
    );
  }

  return (
    <Shell on={false}>
      {rule?.lastNote && <Banner>{rule.lastNote}</Banner>}
      {!open && !setup && (
        <>
          <Note>
            Laxu can repay part of this loan for you, from your wallet, when its health factor drops. You choose when, how much, and you can switch it off
            any time.
          </Note>
          {leftover && rule && (
            <>
              <Banner>Protection is off, but Laxu&apos;s permission is still on your wallet.</Banner>
              <Action label={busy ? "Working…" : "Remove it"} subtle disabled={busy} onClick={() => void turnOff(rule, true)} />
            </>
          )}
          {rule && !rule.enabled && rule.policyId && !leftover && rule.events.length > 0 && rule.events[0].kind !== "DISABLED" && (
            <Action label={busy ? "Working…" : "Finish setup"} disabled={busy} onClick={() => resume(rule)} />
          )}
          {steps && <Steps steps={steps} />}
          {error && <ErrorLine>{error}</ErrorLine>}
          <Action label="Set up protection" disabled={busy} onClick={() => setOpen(true)} />
          <Warnings />
        </>
      )}

      {(open || setup) && (
        <>
          <Slider
            label="WHEN HEALTH DROPS TO"
            value={trigger}
            min={TRIGGER_MIN}
            max={TRIGGER_MAX}
            disabled={busy || setup !== null}
            hint={hf === null ? "no debt yet" : `now ${hf.toFixed(2)}`}
            onChange={(v) => {
              setTrigger(v);
              if (target < v + GAP) setTarget(Math.min(TARGET_MAX, round2(v + GAP)));
            }}
          />
          <Slider
            label="REPAY BACK UP TO"
            value={target}
            min={round2(trigger + GAP)}
            max={TARGET_MAX}
            disabled={busy || setup !== null}
            onChange={setTarget}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label htmlFor="laxu-protect-spend" style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" }}>
                MOST IT MAY SPEND IN TOTAL ({symbol})
              </label>
              <span style={{ fontFamily: MONO, fontSize: 10.5, color: "#a79bd0" }}>in wallet {fmt(lending.walletAsset, decimals)}</span>
            </div>
            <input
              id="laxu-protect-spend"
              value={spendText}
              inputMode="decimal"
              disabled={busy || setup !== null}
              onChange={(e) => setSpendText(e.target.value.replace(/[^0-9.]/g, ""))}
              style={{
                fontFamily: MONO,
                fontSize: 15,
                padding: "11px 12px",
                borderRadius: 10,
                color: "#fdfbf7",
                background: "rgba(255,255,255,0.07)",
                border: `1px solid ${spend === null ? "#ff8a8a" : "rgba(255,255,255,0.16)"}`,
                outline: "none",
                width: "100%",
                boxSizing: "border-box",
              }}
            />
            {spend === null && <div style={{ fontSize: 11, fontWeight: 600, color: "#ff8a8a" }}>Enter an amount above zero</div>}
          </div>

          {preview && (
            <Note>
              {preview.reason === "ok" || preview.reason === "balance"
                ? `Getting from ${hf === null ? "here" : hf.toFixed(2)} to ${target.toFixed(2)} would take about ${fmt(preview.amount, decimals)} ${symbol} right now${preview.reason === "balance" ? " (limited by what is in your wallet)" : ""}.`
                : preview.reason === "no-debt"
                  ? "You have no debt on this loan yet, so there is nothing to repay."
                  : "Your health is already at or above that target, so nothing would be repaid right now."}
            </Note>
          )}

          <div style={{ background: CELL_BG, border: `1px solid ${HAIRLINE}`, borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0", marginBottom: 6 }}>WHAT YOU ARE ALLOWING</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.55, color: "#fdfbf7" }}>
              Laxu will be allowed to call <code style={{ fontFamily: MONO }}>repay</code> on this loan&apos;s pool from your wallet, only when your health drops to{" "}
              <b>{trigger.toFixed(2)}</b>, for at most <b>{perCall === null ? "…" : `${fmt(perCall, decimals)} ${symbol}`}</b> per call and{" "}
              <b>{spend === null ? "…" : `${fmt(spend, decimals)} ${symbol}`}</b> in total. It cannot send your funds anywhere else. You can turn this off at any
              time.
            </div>
            <PrivyCaption>
              Layer 1, a Privy policy, limits <i>what</i> Laxu can call. Layer 2, your spending limit, limits <i>how much</i>.
            </PrivyCaption>
          </div>

          {steps && <Steps steps={steps} />}
          {error && <ErrorLine>{error}</ErrorLine>}

          <div style={{ display: "flex", gap: 8 }}>
            {!busy && !setup && <Action label="Cancel" subtle onClick={() => { setOpen(false); setError(null); setSteps(null); }} />}
            <Action
              label={busy ? "Working…" : setup ? "Continue" : "Set up protection"}
              disabled={busy || spend === null}
              onClick={() => void begin()}
            />
          </div>
          <Warnings />
        </>
      )}
    </Shell>
  );
}

// --- pieces -----------------------------------------------------------------------

function Shell({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <Panel>
      <PanelHead label="PROTECT THIS LOAN" />
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        {on && (
          <span
            style={{
              alignSelf: "flex-start",
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: "0.1em",
              padding: "4px 10px",
              borderRadius: 99,
              color: "#5fe3a8",
              border: "1px solid #5fe3a8",
            }}
          >
            PROTECTED
          </span>
        )}
        {children}
      </div>
    </Panel>
  );
}

function OnView({ rule, decimals, symbol }: { rule: ProtectionRule; decimals: number; symbol: string }) {
  const hf = rule.healthFactor == null ? null : Number(rule.healthFactor);
  const rows: Array<{ k: string; v: React.ReactNode }> = [
    { k: "Health now", v: hf === null ? "no debt" : hf.toFixed(2) },
    { k: "Acts at", v: `${Number(rule.triggerHealth).toFixed(2)} → repays to ${Number(rule.targetHealth).toFixed(2)}` },
    { k: "Spent", v: `${fmt(BigInt(rule.spent), decimals)} of ${fmt(BigInt(rule.maxSpend), decimals)} ${symbol}` },
    { k: "Remaining", v: `${fmt(BigInt(rule.remaining), decimals)} ${symbol}` },
    { k: "Per repay, at most", v: `${fmt(BigInt(rule.maxPerCall), decimals)} ${symbol}` },
    { k: "In your wallet", v: rule.walletBalance == null ? "…" : `${fmt(BigInt(rule.walletBalance), decimals)} ${symbol}` },
  ];
  const last = rule.events.find((e) => e.kind === "REPAID");
  return (
    <>
      {rule.lastNote && <Banner>{rule.lastNote}</Banner>}
      <div style={{ display: "flex", flexDirection: "column", gap: 1, background: HAIRLINE, borderRadius: 10, overflow: "hidden" }}>
        {rows.map((r) => (
          <div key={r.k} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "9px 11px", background: CELL_BG }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "#a79bd0" }}>{r.k}</span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: "#fdfbf7", textAlign: "right" }}>{r.v}</span>
          </div>
        ))}
      </div>
      <PrivyCaption>
        Laxu may only call <code style={{ fontFamily: MONO }}>repay</code> on this pool, up to {fmt(BigInt(rule.maxPerCall), decimals)} {symbol} a time. Privy enforces
        that, and your spending limit caps the total.
      </PrivyCaption>
      <div style={{ fontSize: 11.5, color: "#c2b6e4" }}>
        {last ? (
          <>
            Last repay: {fmt(BigInt(last.amount ?? "0"), decimals)} {symbol}
            {last.healthBefore && last.healthAfter ? `, health ${last.healthBefore.slice(0, 4)} → ${last.healthAfter.slice(0, 4)}` : ""} · {ago(last.createdAt)}{" "}
            <TxLink hash={last.txHash} />
          </>
        ) : (
          "No repays yet."
        )}
      </div>
      <Events events={rule.events} decimals={decimals} symbol={symbol} />
    </>
  );
}

function Events({ events, decimals, symbol }: { events: ProtectionEvent[]; decimals: number; symbol: string }) {
  if (events.length === 0) return null;
  const line = (e: ProtectionEvent): string => {
    switch (e.kind) {
      case "REPAID":
        return `Repaid ${fmt(BigInt(e.amount ?? "0"), decimals)} ${symbol}`;
      case "PENDING":
        return "Repaying…";
      case "FAILED":
        return "A repay attempt failed";
      case "SKIPPED":
        return e.note ?? "Skipped";
      case "ENABLED":
        return "Protection turned on";
      case "DISABLED":
        return "Protection turned off";
    }
  };
  return (
    <ul aria-label="Protection activity" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 5 }}>
      {events.slice(0, 8).map((e) => (
        <li key={e.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, color: "#a79bd0" }}>
          <span>
            {line(e)} <TxLink hash={e.txHash} />
          </span>
          <span style={{ fontFamily: MONO, flex: "none" }}>{ago(e.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}

function TxLink({ hash }: { hash: string | null }) {
  const href = hash ? txLink(hash) : null;
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: "#ffd29c" }}>
      tx ↗
    </a>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol aria-label="Setup steps" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      {steps.map((step, i) => {
        const color = { done: "#5fe3a8", active: "#ffd29c", failed: "#ff8a8a", pending: "#6f6596" }[step.status];
        const symbol = { done: "✓", active: "…", failed: "✕", pending: String(i + 1) }[step.status];
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
              {symbol}
            </span>
            {step.label}
            {step.privy && <span style={{ fontSize: 10, fontWeight: 600, color: "#a79bd0" }}>· Powered by Privy</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Slider({
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
        onChange={(e) => onChange(round2(Number(e.target.value)))}
        style={{ width: "100%", accentColor: "#9670ff" }}
      />
    </div>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" style={{ fontSize: 11.5, fontWeight: 600, lineHeight: 1.45, padding: "9px 11px", borderRadius: 10, color: "#ffd29c", background: "rgba(255,181,101,0.1)", border: "1px solid rgba(255,181,101,0.35)" }}>
      {children}
    </div>
  );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" style={{ fontSize: 11.5, fontWeight: 600, lineHeight: 1.45, color: "#ffb4a8" }}>
      {children}
    </div>
  );
}

function PrivyCaption({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10.5, lineHeight: 1.5, color: "#a79bd0", marginTop: 4 }}>{children} Powered by Privy.</div>;
}

/** Always visible: what protection cannot do. */
function Warnings() {
  return (
    <ul style={{ margin: 0, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 4, fontSize: 11, lineHeight: 1.45, color: "#c2b6e4" }}>
      <li>Needs AUSD in your wallet. If your wallet is empty, protection cannot act.</li>
      <li>A very fast market move can still liquidate you between checks.</li>
    </ul>
  );
}

// --- helpers ----------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A typed amount in the asset's base units; null when blank, malformed or zero. */
function parseSpend(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const units = BigInt(whole) * BigInt(10) ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals));
  return units > BigInt(0) ? units : null;
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** One plain line: the backend's message, a wallet rejection, or Privy's. Never a raw dump. */
function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  const message = txErrorMessage(err);
  return /exited|closed|cancel|reject|denied/i.test(message) ? "Cancelled." : message;
}
