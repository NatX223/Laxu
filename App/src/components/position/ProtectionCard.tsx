"use client";

import { useCallback, useEffect, useState } from "react";
import { formatUnits, type Address } from "viem";
import { readLendingState, setExactAllowance, type LendingState } from "@/lib/actions";
import type { PublicPosition } from "@/lib/api";
import { useAsset } from "@/lib/asset";
import { env } from "@/lib/env";
import { useLaxuSigner } from "@/lib/privySigner";
import {
  disableProtection,
  friendlyError,
  getProtection,
  getProtectionEligibility,
  type FriendlyError,
  type ProtectionList,
  type ProtectionRule,
} from "@/lib/protection";
import { useSession } from "@/lib/session";
import { getWalletClient } from "@/lib/walletClient";
import { Action, Note } from "./HolderActions";
import ProtectionEvents from "./ProtectionEvents";
import {
  Banner,
  ErrorLine,
  MON_LOW_WEI,
  SafetyNote,
  Steps,
  Warnings,
  ago,
  fmt,
  txLink,
  type Ctx,
  type Step,
} from "./ProtectionParts";
import ProtectionSetup from "./ProtectionSetup";
import { CELL_BG, HAIRLINE, MONO, Panel, PanelHead } from "./shared";

/**
 * "Protect this loan" (Spec 05b): Laxu repays part of the user's loan from their own Privy embedded wallet when
 * its health factor drops, within limits they set. Behind NEXT_PUBLIC_ENABLE_PROTECTION; off, it renders nothing.
 *
 * Nothing says "Protected" until the backend has checked the signer and the allowance itself (the rule's phase
 * comes from the backend). The states: off, setup/finish setup, on, and cleanup (off, but a permission is left).
 */

const POLL_IDLE_MS = 10_000; // while the card is just sitting there
const POLL_FORM_MS = 5_000; // the setup form is open: balances are shown live
const POLL_BUSY_MS = 3_000; // a setup or turn-off is running
const HEALTH_GOOD = 1.5;
const HEALTH_WATCH = 1.1;

export default function ProtectionCard(props: { live: PublicPosition; refreshKey: number; onDone: (message: string) => void }) {
  // Flag off, or no Privy configured (no PrivyProvider for useSigners): nothing at all.
  if (!env.protectionEnabled || !env.privyAppId) return null;
  return <Card {...props} />;
}

function Card({ live, refreshKey, onDone }: { live: PublicPosition; refreshKey: number; onDone: (message: string) => void }) {
  const { wallet, user } = useSession();
  const signer = useLaxuSigner();
  const { symbol } = useAsset();
  const account = wallet?.address as Address | undefined;
  const token = live.positionTokenAddress as Address;
  const pool = live.lendingPoolAddress as Address | null;

  const [list, setList] = useState<ProtectionList | null>(null);
  const [lending, setLending] = useState<LendingState | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [flowBusy, setFlowBusy] = useState(false);
  const [flowSteps, setFlowSteps] = useState<Step[] | null>(null);
  const [flowError, setFlowError] = useState<FriendlyError | null>(null);

  const pollMs = setupBusy || flowBusy ? POLL_BUSY_MS : setupOpen ? POLL_FORM_MS : POLL_IDLE_MS;

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

  const reload = useCallback(async () => apply(await read()), [apply, read]);

  // Poll while the tab is visible, at the pace the current state needs; pick up again the moment it comes back.
  // A new refreshKey (the page did something) restarts this, so it also refreshes at once.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const visible = typeof document === "undefined" || document.visibilityState === "visible";
      (visible ? read().then((result) => !cancelled && apply(result)) : Promise.resolve()).finally(() => {
        if (!cancelled) timer = setTimeout(tick, pollMs);
      });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        tick();
      }
    };
    tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [read, apply, refreshKey, pollMs]);

  const eligibility = getProtectionEligibility({
    wallet: wallet ? { address: wallet.address, walletClientType: wallet.walletClientType } : null,
    user,
    debt: lending ? lending.debt : null,
    hasPool: Boolean(pool),
  });
  const rule = list?.rules.find((r) => r.poolAddress === pool?.toLowerCase()) ?? null;

  if (eligibility.kind === "hidden" || !wallet || !account || !pool || !lending) return null;

  if (eligibility.kind === "not-embedded") {
    return (
      <Shell on={false}>
        <Note>Loan protection needs a Laxu wallet created with email sign-in.</Note>
      </Shell>
    );
  }

  const { decimals } = lending;
  const monWei = list?.walletNativeBalance != null ? BigInt(list.walletNativeBalance) : null;
  const lowMon = monWei !== null && monWei < MON_LOW_WEI;
  const ctx: Ctx = {
    account,
    wallet,
    pool,
    assetAddress: env.assetAddress as Address,
    decimals,
    symbol,
    signerId: list?.signerId ?? "",
    cap: list ? BigInt(list.maxSpendCap) : null,
    lending,
    monWei,
  };

  // --- flows: turn off, cleanup, top up -----------------------------------------------------------------

  const mark = (rows: Step[], index: number, status: Step["status"]) => {
    rows[index] = { ...rows[index], status };
    setFlowSteps([...rows]);
  };

  /** Run named steps in order; the first to fail stops the rest and is reported in plain words. */
  const runFlow = async (rows: Step[], actions: Array<() => Promise<unknown>>, finished?: string) => {
    setFlowBusy(true);
    setFlowError(null);
    setFlowSteps([...rows]);
    let index = 0;
    try {
      for (index = 0; index < actions.length; index += 1) {
        if (rows[index].status === "done") continue;
        mark(rows, index, "active");
        await actions[index]();
        mark(rows, index, "done");
      }
      setFlowSteps(null);
      if (finished) onDone(finished);
    } catch (err) {
      mark(rows, index, "failed");
      setFlowError(friendlyError(err));
    } finally {
      setFlowBusy(false);
      await reload();
    }
  };

  const removePermission = () => signer.revoke({ walletAddress: account });
  const setLimit = async (amount: bigint) => {
    const client = await getWalletClient(wallet);
    await setExactAllowance(client, ctx.assetAddress, pool, amount);
  };

  /** Order matters: the backend stops first (that is what makes the user safe, and needs no Privy), then the permission, then the allowance. */
  const turnOff = (r: ProtectionRule) => {
    setConfirmOff(false);
    return runFlow(
      [
        { key: "stop", label: "Stop Laxu acting", status: "pending" },
        { key: "signer", label: "Remove Laxu's permission", status: "pending", privy: true },
        { key: "allowance", label: "Set the spending limit to 0", status: "pending" },
      ],
      [() => disableProtection(r.id), removePermission, () => setLimit(BigInt(0))],
      "Loan protection is off",
    );
  };

  const leftoverSigner = rule?.walletHasSigner === true;
  const leftoverAllowance = rule?.allowance != null && BigInt(rule.allowance) > BigInt(0);

  /** Cleanup: only what is actually left. */
  const finishCleaning = () => {
    const rows: Step[] = [];
    const actions: Array<() => Promise<unknown>> = [];
    if (leftoverSigner) {
      rows.push({ key: "signer", label: "Remove Laxu's permission", status: "pending", privy: true });
      actions.push(removePermission);
    }
    if (leftoverAllowance) {
      rows.push({ key: "allowance", label: "Set the spending limit to 0", status: "pending" });
      actions.push(() => setLimit(BigInt(0)));
    }
    return runFlow(rows, actions, "Loan protection is fully off");
  };

  const topUp = (r: ProtectionRule) =>
    runFlow([{ key: "allowance", label: "Set the spending limit to what is left", status: "pending" }], [() => setLimit(BigInt(r.remaining))], "Spending limit updated");

  // --- which view -----------------------------------------------------------------------------------------

  // A rule created but not switched on, or the form open: the setup panel (one instance, so it keeps its place).
  if (setupOpen || rule?.phase === "setup") {
    return (
      <Shell on={false}>
        <ProtectionSetup
          key="setup"
          ctx={ctx}
          resume={setupOpen ? null : rule}
          onClose={() => setSetupOpen(false)}
          onChanged={reload}
          onDone={onDone}
          onBusy={setSetupBusy}
        />
      </Shell>
    );
  }

  if (rule?.phase === "on") {
    const remaining = BigInt(rule.remaining);
    const allowanceLow = rule.allowance != null && remaining > BigInt(0) && BigInt(rule.allowance) < remaining;
    return (
      <Shell on>
        {rule.lastNote && <Banner>{rule.lastNote}</Banner>}
        {lowMon && <Warnings symbol={symbol} lowMon />}
        <OnTable rule={rule} decimals={decimals} symbol={symbol} monWei={monWei} />
        {allowanceLow && (
          <Banner>
            Allowance low: protection may stop early.{" "}
            <button
              type="button"
              disabled={flowBusy}
              onClick={() => void topUp(rule)}
              style={{ fontFamily: "inherit", fontSize: "inherit", fontWeight: 700, color: "#ffd29c", background: "none", border: "none", padding: 0, textDecoration: "underline", cursor: "pointer" }}
            >
              Top up allowance
            </button>
          </Banner>
        )}
        <LastAction rule={rule} decimals={decimals} symbol={symbol} />
        <ProtectionEvents events={rule.events} decimals={decimals} symbol={symbol} />
        {flowSteps && <Steps steps={flowSteps} label="Turn-off steps" />}
        <ErrorLine error={flowError} />
        {confirmOff ? (
          <div role="group" aria-label="Confirm turning off" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Note>Turn off protection? Laxu will stop watching this loan.</Note>
            <div style={{ display: "flex", gap: 8 }}>
              <Action label="Keep protection" subtle onClick={() => setConfirmOff(false)} />
              <Action label="Turn off" disabled={flowBusy} onClick={() => void turnOff(rule)} />
            </div>
          </div>
        ) : (
          <Action label={flowBusy ? "Working…" : "Turn off"} subtle disabled={flowBusy} onClick={() => setConfirmOff(true)} />
        )}
        <SafetyNote />
        {!lowMon && <Warnings symbol={symbol} lowMon={false} />}
      </Shell>
    );
  }

  if (rule?.phase === "off" && (leftoverSigner || leftoverAllowance)) {
    return (
      <Shell on={false}>
        <Banner>Protection is off and Laxu cannot act, but the permission is still on your wallet.</Banner>
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11.5, color: "#c2b6e4", lineHeight: 1.5 }}>
          {leftoverSigner && <li>Laxu&apos;s permission to repay is still on your wallet.</li>}
          {leftoverAllowance && rule.allowance && <li>The pool can still spend up to {fmt(BigInt(rule.allowance), decimals)} {symbol} of yours.</li>}
        </ul>
        {flowSteps && <Steps steps={flowSteps} label="Cleanup steps" />}
        <ErrorLine error={flowError} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {leftoverSigner && (
            <Action label={flowBusy ? "Working…" : "Remove Laxu's permission"} subtle disabled={flowBusy} onClick={() => void runFlow([{ key: "signer", label: "Remove Laxu's permission", status: "pending", privy: true }], [removePermission], "Laxu's permission is removed")} />
          )}
          {leftoverAllowance && (
            <Action label={flowBusy ? "Working…" : "Set spending limit to 0"} subtle disabled={flowBusy} onClick={() => void runFlow([{ key: "allowance", label: "Set the spending limit to 0", status: "pending" }], [() => setLimit(BigInt(0))], "Spending limit set to 0")} />
          )}
        </div>
        {leftoverSigner && leftoverAllowance && <Action label={flowBusy ? "Working…" : "Clean up both"} disabled={flowBusy} onClick={() => void finishCleaning()} />}
        <SafetyNote />
      </Shell>
    );
  }

  // Off: no rule, or one that was turned off and left nothing behind.
  const noDebt = eligibility.kind === "no-debt";
  return (
    <Shell on={false}>
      {rule?.lastNote && rule.phase === "off" && <Banner tone="info">{rule.lastNote}</Banner>}
      <Note>Laxu watches your loan and repays part of it from your wallet if your health drops, within limits you set.</Note>
      {noDebt && <Note>Borrow first. Protection watches an open loan.</Note>}
      <Action label="Set up protection" disabled={noDebt || flowBusy} onClick={() => { setFlowError(null); setSetupOpen(true); }} />
      <SafetyNote />
      <Warnings symbol={symbol} lowMon={lowMon} />
    </Shell>
  );
}

// --- pieces -----------------------------------------------------------------------------------------------

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

const hfColor = (hf: number) => (hf >= HEALTH_GOOD ? "#5fe3a8" : hf >= HEALTH_WATCH ? "#ffb765" : "#ff6b57");

function OnTable({ rule, decimals, symbol, monWei }: { rule: ProtectionRule; decimals: number; symbol: string; monWei: bigint | null }) {
  const hf = rule.healthFactor == null ? null : Number(rule.healthFactor);
  const rows: Array<{ k: string; v: React.ReactNode }> = [
    { k: "Health now", v: hf === null ? "no debt" : <span style={{ color: hfColor(hf) }}>{hf.toFixed(2)}</span> },
    { k: "Acts at", v: `${Number(rule.triggerHealth).toFixed(2)} → repays to ${Number(rule.targetHealth).toFixed(2)}` },
    { k: "Spent", v: `${fmt(BigInt(rule.spent), decimals)} of ${fmt(BigInt(rule.maxSpend), decimals)} ${symbol}` },
    { k: "Remaining", v: `${fmt(BigInt(rule.remaining), decimals)} ${symbol}` },
    { k: "Allowance left", v: rule.allowance == null ? "…" : `${fmt(BigInt(rule.allowance), decimals)} ${symbol}` },
    { k: "Per repay, at most", v: `${fmt(BigInt(rule.maxPerCall), decimals)} ${symbol}` },
    { k: `Wallet ${symbol}`, v: rule.walletBalance == null ? "…" : fmt(BigInt(rule.walletBalance), decimals) },
    { k: "Wallet MON", v: monWei === null ? "…" : Number(formatUnits(monWei, 18)).toFixed(3) },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, background: HAIRLINE, borderRadius: 10, overflow: "hidden" }}>
      {rows.map((r) => (
        <div key={r.k} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "9px 11px", background: CELL_BG }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "#a79bd0" }}>{r.k}</span>
          <span style={{ fontFamily: MONO, fontSize: 12, color: "#fdfbf7", textAlign: "right" }}>{r.v}</span>
        </div>
      ))}
    </div>
  );
}

function LastAction({ rule, decimals, symbol }: { rule: ProtectionRule; decimals: number; symbol: string }) {
  const last = rule.events.find((e) => e.kind === "REPAID");
  if (!last) return <div style={{ fontSize: 11.5, color: "#c2b6e4" }}>No repays yet.</div>;
  const href = last.txHash ? txLink(last.txHash) : null;
  return (
    <div style={{ fontSize: 11.5, color: "#c2b6e4" }}>
      Last repay: {fmt(BigInt(last.amount ?? "0"), decimals)} {symbol}
      {last.healthBefore && last.healthAfter ? `, health ${last.healthBefore.slice(0, 4)} → ${last.healthAfter.slice(0, 4)}` : ""} · {ago(last.createdAt)}{" "}
      {href && (
        <a href={href} target="_blank" rel="noreferrer" style={{ color: "#ffd29c" }}>
          tx ↗
        </a>
      )}
    </div>
  );
}
