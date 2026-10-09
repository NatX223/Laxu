"use client";

import { useState } from "react";
import { formatUnits, type Address } from "viem";
import { setExactAllowance } from "@/lib/actions";
import { ApiError } from "@/lib/api";
import { useLaxuSigner } from "@/lib/privySigner";
import {
  activateProtection,
  createProtection,
  disableProtection,
  friendlyError,
  previewRepay,
  type CreatedProtection,
  type FriendlyError,
  type ProtectionRule,
} from "@/lib/protection";
import { getWalletClient } from "@/lib/walletClient";
import { Action, Note } from "./HolderActions";
import { MONO } from "./shared";
import {
  Banner,
  Consent,
  ErrorLine,
  MON_LOW_WEI,
  SafetyNote,
  Slider,
  Steps,
  Warnings,
  fmt,
  parseAmount,
  round2,
  type Ctx,
  type Step,
} from "./ProtectionParts";

/**
 * Setting protection up, and finishing a setup that was interrupted.
 *
 * Fixed order (Spec 05b 4.2b): create the rule on the backend (invisible), step 1 the Privy signer, step 2 the exact
 * allowance, then ask the backend to activate and show success only when it says enabled. Nothing is granted
 * until the user presses the button under the consent text; that text and button are the only consent the
 * user sees for the signer, because `addSigners` shows no Privy popup on this setup.
 *
 * A reload resumes from server and chain state (the rule's `walletHasSigner` and `allowance`), never from the
 * browser's memory.
 */

const TRIGGER_MIN = 1.05;
const TRIGGER_MAX = 3;
const TARGET_MAX = 5;
const GAP = 0.1;
const ACTIVATE_TRIES = 3;
const ACTIVATE_WAIT_MS = 2_000;

/** What is left to do for one rule, and the numbers its consent text shows. */
type Session = {
  created: CreatedProtection;
  signerDone: boolean;
  allowanceDone: boolean;
  trigger: string;
  perCall: bigint;
  total: bigint;
};

const stepsFor = (s: Session): Step[] => [
  { key: "signer", label: "Step 1 of 2: Allow Laxu to repay", status: s.signerDone ? "done" : "pending", privy: true },
  { key: "allowance", label: "Step 2 of 2: Approve spending limit", status: s.allowanceDone ? "done" : "pending" },
  { key: "activate", label: "Turn protection on", status: "pending" },
];

/** The first incomplete step, worked out from server and chain state (Spec 05b 4.3). */
function sessionFromRule(rule: ProtectionRule, ctx: Ctx): Session {
  const total = BigInt(rule.maxSpend);
  return {
    created: {
      ruleId: rule.id,
      policyId: rule.policyId ?? "",
      signerConfig: { address: ctx.account, signers: [{ signerId: ctx.signerId, policyIds: rule.policyId ? [rule.policyId] : [] }] },
      allowanceToApprove: { token: ctx.assetAddress, spender: ctx.pool, amount: rule.maxSpend, amountHuman: formatUnits(total, ctx.decimals) },
      maxPerCall: rule.maxPerCall,
    },
    signerDone: rule.walletHasSigner === true,
    allowanceDone: rule.allowance != null && BigInt(rule.allowance) === total,
    trigger: Number(rule.triggerHealth).toFixed(2),
    perCall: BigInt(rule.maxPerCall),
    total,
  };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export default function ProtectionSetup({
  ctx,
  resume,
  onClose,
  onChanged,
  onDone,
  onBusy,
}: {
  ctx: Ctx;
  /** The unfinished rule, when the page loaded with one; null for a fresh setup. */
  resume: ProtectionRule | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onDone: (message: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const signer = useLaxuSigner();
  const { lending, decimals, symbol } = ctx;

  const [trigger, setTrigger] = useState(1.15);
  const [target, setTarget] = useState(1.3);
  const [spendText, setSpendText] = useState("50");
  const [session, setSession] = useState<Session | null>(() => (resume ? sessionFromRule(resume, ctx) : null));
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);

  const working = (value: boolean) => {
    setBusy(value);
    onBusy(value);
  };

  const mark = (rows: Step[], index: number, status: Step["status"]) => {
    rows[index] = { ...rows[index], status };
    setSteps([...rows]);
  };

  const activateWithRetry = async (ruleId: string) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await activateProtection(ruleId);
        return;
      } catch (err) {
        // Privy can lag a moment before it lists the signer it just added.
        if (err instanceof ApiError && err.code === "SIGNER_MISSING" && attempt < ACTIVATE_TRIES) {
          await wait(ACTIVATE_WAIT_MS);
          continue;
        }
        throw err;
      }
    }
  };

  /** Runs whatever is left, in order. Each success is remembered so a retry resumes where it stopped. */
  const run = async (start: Session) => {
    const s = { ...start };
    const rows = stepsFor(s);
    setSteps([...rows]);
    setError(null);
    working(true);
    let index = 0;
    try {
      if (!s.signerDone) {
        index = 0;
        mark(rows, 0, "active");
        const grant = s.created.signerConfig.signers[0];
        await signer.grant({ walletAddress: ctx.account, signerId: grant.signerId, policyIds: grant.policyIds });
        s.signerDone = true;
        setSession({ ...s });
        mark(rows, 0, "done");
      }
      if (!s.allowanceDone) {
        index = 1;
        mark(rows, 1, "active");
        const client = await getWalletClient(ctx.wallet);
        const { token, spender, amount } = s.created.allowanceToApprove;
        await setExactAllowance(client, token as Address, spender as Address, BigInt(amount));
        s.allowanceDone = true;
        setSession({ ...s });
        mark(rows, 1, "done");
      }
      index = 2;
      mark(rows, 2, "active");
      await activateWithRetry(s.created.ruleId); // success is shown only when the backend, having checked, says enabled
      mark(rows, 2, "done");
      onDone("Loan protection is on");
      await onChanged();
      onClose();
    } catch (err) {
      mark(rows, index, "failed");
      setError(friendlyError(err));
    } finally {
      working(false);
    }
  };

  // --- the form (a fresh setup) ---------------------------------------------------------------------

  const spend = parseAmount(spendText, decimals);
  const perCall = spend === null ? null : spend / BigInt(2);
  const overCap = spend !== null && ctx.cap !== null && spend > ctx.cap;
  const formValid = spend !== null && !overCap;
  const preview =
    spend === null || perCall === null
      ? null
      : previewRepay({
          debt: lending.debt,
          collateralValue: lending.collateralValue,
          thresholdBps: lending.liquidationThresholdBps,
          targetHealth: target.toFixed(2),
          maxPerCall: perCall,
          maxSpend: spend,
          spent: BigInt(0),
          walletBalance: lending.walletAsset,
          allowance: spend, // what the setup is about to approve
        });
  const hf = lending.healthFactor === null ? null : Number(formatUnits(lending.healthFactor, 18));
  const lowMon = ctx.monWei !== null && ctx.monWei < MON_LOW_WEI;

  const begin = async () => {
    setError(null);
    if (session) {
      await run(session);
      return;
    }
    if (!formValid) return;
    working(true);
    let fresh: Session;
    try {
      // Nothing is granted yet: this only creates the rule and its Privy policy on the backend.
      const created = await createProtection({
        pool: ctx.pool,
        triggerHealth: trigger.toFixed(2),
        targetHealth: target.toFixed(2),
        maxSpend: spendText.trim(),
      });
      fresh = {
        created,
        signerDone: false,
        allowanceDone: false,
        trigger: trigger.toFixed(2),
        perCall: BigInt(created.maxPerCall),
        total: BigInt(created.allowanceToApprove.amount),
      };
      setSession(fresh);
    } catch (err) {
      setError(friendlyError(err));
      working(false);
      return;
    }
    working(false);
    await run(fresh);
  };

  /** Leave the rule disabled. If a permission or allowance was already granted, the card's cleanup state takes over. */
  const cancel = async () => {
    working(true);
    try {
      if (session) await disableProtection(session.created.ruleId);
    } catch (err) {
      setError(friendlyError(err));
      working(false);
      return;
    }
    working(false);
    await onChanged();
    onClose();
  };

  // --- render --------------------------------------------------------------------------------------

  const failed = steps?.find((s) => s.status === "failed");
  const nextIsSigner = session ? !session.signerDone : true;
  const label = busy
    ? "Working…"
    : failed && failed.key !== "signer"
      ? "Retry this step"
      : nextIsSigner
        ? "I understand, allow Laxu to repay"
        : "Continue";
  const showSteps = steps ?? (session ? stepsFor(session) : null);

  return (
    <>
      {resume && !steps && <Banner tone="info">Setup not finished. Pick up where you left off, or cancel it.</Banner>}

      {!session && (
        <>
          <Slider
            label="WHEN HEALTH DROPS TO"
            value={trigger}
            min={TRIGGER_MIN}
            max={TRIGGER_MAX}
            disabled={busy}
            hint={hf === null ? "no debt yet" : `now ${hf.toFixed(2)}`}
            onChange={(v) => {
              setTrigger(v);
              if (target < v + GAP) setTarget(Math.min(TARGET_MAX, round2(v + GAP)));
            }}
          />
          <Slider label="REPAY BACK UP TO" value={target} min={round2(trigger + GAP)} max={TARGET_MAX} disabled={busy} onChange={setTarget} />

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="laxu-protect-spend" style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" }}>
              MOST IT MAY SPEND IN TOTAL ({symbol})
            </label>
            <input
              id="laxu-protect-spend"
              value={spendText}
              inputMode="decimal"
              disabled={busy}
              onChange={(e) => setSpendText(e.target.value.replace(/[^0-9.]/g, ""))}
              style={{
                fontFamily: MONO,
                fontSize: 15,
                padding: "11px 12px",
                borderRadius: 10,
                color: "#fdfbf7",
                background: "rgba(255,255,255,0.07)",
                border: `1px solid ${formValid ? "rgba(255,255,255,0.16)" : "#ff8a8a"}`,
                outline: "none",
                width: "100%",
                boxSizing: "border-box",
              }}
            />
            {spend === null && <div style={{ fontSize: 11, fontWeight: 600, color: "#ff8a8a" }}>Enter an amount above zero</div>}
            {overCap && ctx.cap !== null && (
              <div style={{ fontSize: 11, fontWeight: 600, color: "#ff8a8a" }}>The most you can set is {fmt(ctx.cap, decimals)} {symbol}</div>
            )}
            <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#a79bd0", display: "flex", flexWrap: "wrap", gap: "2px 12px" }}>
              <span>
                per call at most {perCall === null ? "…" : fmt(perCall, decimals)} {symbol}
              </span>
              <span>
                wallet {fmt(lending.walletAsset, decimals)} {symbol}
              </span>
              <span>wallet {ctx.monWei === null ? "…" : Number(formatUnits(ctx.monWei, 18)).toFixed(3)} MON</span>
              <span>health now {hf === null ? "no debt yet" : hf.toFixed(2)}</span>
            </div>
          </div>

          {preview && (
            <Note>
              {preview.reason === "ok" || preview.reason === "limit:balance" || preview.reason === "limit:maxPerCall"
                ? preview.amount > BigInt(0)
                  ? `Getting from ${hf === null ? "here" : hf.toFixed(2)} to ${target.toFixed(2)} would take about ${fmt(preview.needed, decimals)} ${symbol}; this would repay about ${fmt(preview.amount, decimals)} ${symbol} now${preview.limitedBy === "balance" ? " (limited by what is in your wallet)" : preview.limitedBy === "maxPerCall" ? " (limited by the per-call cap)" : ""}.`
                  : "With what is in your wallet, nothing could be repaid right now."
                : preview.reason === "no-debt"
                  ? "You have no debt on this loan yet, so there is nothing to repay."
                  : "Your health is already at or above that target, so nothing would be repaid right now."}
            </Note>
          )}
        </>
      )}

      <Consent
        trigger={session ? session.trigger : trigger.toFixed(2)}
        perCall={session ? session.perCall : perCall}
        total={session ? session.total : spend}
        symbol={symbol}
        decimals={decimals}
      />

      {showSteps && <Steps steps={showSteps} label="Setup steps" />}
      <ErrorLine error={error} />

      <div style={{ display: "flex", gap: 8 }}>
        {(!session || failed || resume) && (
          <Action
            label={session ? "Cancel setup" : "Cancel"}
            subtle
            disabled={busy}
            onClick={() => (session ? void cancel() : onClose())}
          />
        )}
        <Action label={label} disabled={busy || (!session && !formValid)} onClick={() => void begin()} />
      </div>

      <SafetyNote />
      <Warnings symbol={symbol} lowMon={lowMon} />
    </>
  );
}
