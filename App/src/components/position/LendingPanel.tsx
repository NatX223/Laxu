"use client";

import { useCallback, useEffect, useState } from "react";
import { erc20Abi, formatUnits, parseUnits, type Address } from "viem";
import {
  STALE_ORACLE_MESSAGE,
  WAD,
  depositAndBorrow,
  postCollateral,
  readLendingState,
  repay,
  txErrorMessage,
  withdrawCollateral,
  type BorrowStep,
  type LendingState,
} from "@/lib/actions";
import type { PublicPosition } from "@/lib/api";
import { publicClient } from "@/lib/chain";
import { useFaucet } from "@/lib/faucet";
import { useSession } from "@/lib/session";
import { getWalletClient } from "@/lib/walletClient";
import { Action, Note } from "./HolderActions";
import { CELL_BG, HAIRLINE, MONO, Panel, PanelHead } from "./shared";

/**
 * Borrow USDG against this position's tokens, through its LendingPool:
 * post tokens as collateral, borrow up to the LTV cap, repay, withdraw.
 * Borrow counts tokens still in the wallet too: when the amount needs them it
 * posts them first (approve → deposit → borrow), showing each step.
 *
 * Shown to anyone holding the token (in the wallet or posted). While the
 * backend is still creating the pool it says so; the page polls until the
 * address appears. Every figure is read live from the pool — interest accrues
 * and the collateral's value moves with the position.
 */

const POLL_MS = 15_000;
const BPS = BigInt(10_000);
/** "Repay all": debt read now plus 0.1% for interest accrued before the tx lands. Over-payment is trimmed on-chain. */
const REPAY_BUFFER_BPS = BigInt(10);

type Mode = "borrow" | "deposit" | "repay" | "withdraw";

const MODES: Array<{ key: Mode; label: string }> = [
  { key: "borrow", label: "Borrow" },
  { key: "deposit", label: "Deposit only" },
  { key: "repay", label: "Repay" },
  { key: "withdraw", label: "Withdraw" },
];

/** LendingPool's leverage tiers — the pool's own ltvBps is what's enforced. */
function tierLabel(leverage: number, ltvBps: bigint): string {
  const band = leverage <= 5 ? "1–5×" : leverage <= 10 ? "6–10×" : "11–20×";
  return `${Number(ltvBps) / 100}% (${band})`;
}

function hfColor(hf: number): string {
  if (hf >= 1.5) return "#5fe3a8";
  if (hf >= 1.1) return "#ffb765";
  return "#ff6b57";
}

const fmt = (amount: bigint, decimals: number, dp = 2) =>
  Number(formatUnits(amount, decimals)).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** Parse a typed amount; null when blank or malformed. */
function parseAmount(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  try {
    return parseUnits(trimmed, decimals);
  } catch {
    return null;
  }
}

/**
 * Health factor (WAD) after withdrawing `shares`, or null with no debt. The
 * collateral's value scales with the shares left; matches the pool's check.
 */
function healthAfterWithdraw(s: LendingState, shares: bigint): bigint | null {
  if (s.debt === BigInt(0)) return null;
  if (s.collateralShares === BigInt(0) || shares >= s.collateralShares) return BigInt(0);
  const valueAfter = (s.collateralValue * (s.collateralShares - shares)) / s.collateralShares;
  return (valueAfter * s.liquidationThresholdBps * WAD) / (BPS * s.debt);
}

export default function LendingPanel({
  live,
  refreshKey,
  onDone,
  onCollateralChange,
}: {
  live: PublicPosition;
  refreshKey: number;
  onDone: (message: string) => void;
  /** Tells the page whether this wallet has tokens posted (the header's chip). */
  onCollateralChange: (collateralized: boolean) => void;
}) {
  const { wallet } = useSession();
  const refreshFaucet = useFaucet().refresh;
  const account = wallet?.address as Address | undefined;
  const token = live.positionTokenAddress as Address;
  const pool = live.lendingPoolAddress as Address | null;

  const [state, setState] = useState<LendingState | null>(null);
  /** Token balance before the pool exists, to decide whether to show "being created". */
  const [heldBeforePool, setHeldBeforePool] = useState<bigint | null>(null);
  const [mode, setMode] = useState<Mode>("borrow");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The combined borrow's progress; kept after a failure to show where it stopped. */
  const [flow, setFlow] = useState<Flow | null>(null);

  /** The pool's figures, or before the pool exists just the wallet's token balance. */
  const read = useCallback(async () => {
    if (!account) return null;
    if (pool) return { kind: "pool" as const, lending: await readLendingState(pool, token, account) };
    const held = await publicClient().readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
    return { kind: "no-pool" as const, held };
  }, [account, pool, token]);

  const apply = useCallback(
    (result: Awaited<ReturnType<typeof read>>) => {
      if (!result) return;
      if (result.kind === "pool") {
        setState(result.lending);
        onCollateralChange(result.lending.collateralShares > BigInt(0));
      } else {
        setHeldBeforePool(result.held);
      }
    },
    [onCollateralChange],
  );

  const refresh = useCallback(async () => {
    try {
      apply(await read());
    } catch (err) {
      console.error("could not read lending state", err);
    }
  }, [read, apply]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      read()
        .then((result) => {
          if (!cancelled) apply(result);
        })
        .catch((err) => console.error("could not read lending state", err));
    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [read, apply, refreshKey]);

  if (!wallet || !account) return null;

  if (!pool) {
    if (!heldBeforePool || heldBeforePool === BigInt(0)) return null;
    return (
      <Panel>
        <PanelHead label="BORROW AGAINST IT" />
        <div style={{ padding: 16 }}>
          <Note>Lending pool is being created&hellip; this takes a minute after the position opens.</Note>
        </div>
      </Panel>
    );
  }

  if (!state) return null;
  const holds = state.walletShares > BigInt(0) || state.collateralShares > BigInt(0) || state.debt > BigInt(0);
  if (!holds) return null;

  const { decimals } = state;
  const closed = live.lifecycle !== "open";
  const parsed = parseAmount(amount, decimals);
  const hf = state.healthFactor === null ? null : Number(formatUnits(state.healthFactor, 18));

  // Per mode: the cap for "max", what a valid amount must stay under, and why not.
  const repayAll = (() => {
    const withBuffer = state.debt + (state.debt * REPAY_BUFFER_BPS) / BPS;
    return withBuffer <= state.walletUsdg ? withBuffer : state.walletUsdg;
  })();
  const max: Record<Mode, bigint> = {
    deposit: state.walletShares,
    borrow: state.borrowCapacity,
    repay: repayAll,
    withdraw: state.collateralShares,
  };

  // Past what's borrowable now, borrow posts the wallet's tokens first: all of them, which is what the capacity assumes.
  const sharesToPost = mode === "borrow" && parsed !== null && parsed > state.available ? state.walletShares : BigInt(0);
  // The pool gates both on a fresh price report; say so up front instead of letting them revert.
  const blocked = (mode === "borrow" || mode === "withdraw") && state.oracleStale ? STALE_ORACLE_MESSAGE : null;

  let problem: string | null = null;
  if (amount.trim() && parsed === null) problem = "Enter an amount";
  else if (parsed !== null) {
    if (parsed === BigInt(0)) problem = "Enter an amount above zero";
    else if (mode === "deposit" && parsed > state.walletShares) problem = "More than the tokens in your wallet";
    else if (mode === "borrow" && closed) problem = "The position is closed; borrowing is off";
    else if (mode === "borrow" && parsed > state.borrowCapacity) problem = "More than you can borrow";
    else if (mode === "repay" && state.debt === BigInt(0)) problem = "Nothing to repay";
    else if (mode === "repay" && parsed > state.walletUsdg) problem = "More USDG than your wallet holds";
    else if (mode === "withdraw" && parsed > state.collateralShares) problem = "More than you have posted";
    else if (mode === "withdraw") {
      const after = healthAfterWithdraw(state, parsed);
      if (after !== null && after < WAD) problem = "That would leave your health factor below 1. Repay first.";
    }
  }
  const canSubmit = parsed !== null && parsed > BigInt(0) && !problem && !blocked && !busy;

  const submit = async () => {
    if (!canSubmit || parsed === null) return;
    setBusy(true);
    setError(null);
    setFlow(null);
    const shares = sharesToPost;
    let reached: BorrowStep | null = null;
    try {
      const client = await getWalletClient(wallet);
      if (mode === "deposit") await postCollateral(client, token, pool, parsed);
      else if (mode === "borrow") {
        await depositAndBorrow(client, token, pool, shares, parsed, (step) => {
          reached = step;
          if (shares > BigInt(0)) setFlow({ shares, amount: parsed, step, failed: false });
        });
        setFlow(null);
      } else if (mode === "repay") await repay(client, pool, parsed);
      else await withdrawCollateral(client, pool, parsed);
      const done: Record<Mode, string> = {
        deposit: "Collateral posted",
        borrow: `Borrowed ${fmt(parsed, decimals)} USDG`,
        repay: "Repaid",
        withdraw: "Collateral withdrawn to your wallet",
      };
      onDone(done[mode]);
      setAmount("");
    } catch (err) {
      const message = txErrorMessage(err);
      setFlow((f) => (f ? { ...f, failed: true } : f));
      setError(
        reached === "borrow" && shares > BigInt(0)
          ? `Your tokens are posted as collateral, but the borrow didn't go through: ${message}`
          : message,
      );
    } finally {
      setBusy(false);
      await refresh();
      refreshFaucet();
    }
  };

  const rows: Array<{ k: string; v: React.ReactNode }> = [
    {
      k: "Your collateral",
      v: `${fmt(state.collateralShares, decimals, 4)} tokens · $${fmt(state.collateralValue, decimals)}`,
    },
    { k: "Debt", v: `$${fmt(state.debt, decimals)}` },
    {
      k: "You can borrow up to",
      v:
        state.walletShares > BigInt(0) ? (
          <>
            ${fmt(state.borrowCapacity, decimals)}
            <div style={{ fontFamily: "inherit", fontSize: 10, color: "#a79bd0", marginTop: 2 }}>after depositing your tokens</div>
          </>
        ) : (
          `$${fmt(state.borrowCapacity, decimals)}`
        ),
    },
    { k: "LTV tier", v: tierLabel(live.leverage, state.ltvBps) },
  ];

  return (
    <Panel>
      <PanelHead label="BORROW AGAINST IT" />
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        <HealthGauge hf={hf} />

        <div style={{ display: "flex", flexDirection: "column", gap: 1, background: HAIRLINE, borderRadius: 10, overflow: "hidden" }}>
          {rows.map((r) => (
            <div
              key={r.k}
              style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "9px 11px", background: CELL_BG }}
            >
              <span style={{ fontSize: 11, fontWeight: 600, color: "#a79bd0" }}>{r.k}</span>
              <span style={{ fontFamily: MONO, fontSize: 12, color: "#fdfbf7", textAlign: "right" }}>{r.v}</span>
            </div>
          ))}
        </div>

        <div role="tablist" aria-label="Lending action" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, padding: 3, background: "rgba(255,255,255,0.06)", borderRadius: 10 }}>
          {MODES.map((m) => {
            const active = mode === m.key;
            return (
              <button
                key={m.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setMode(m.key);
                  setAmount("");
                  setError(null);
                  setFlow(null);
                }}
                style={{
                  fontFamily: "inherit",
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "8px 2px",
                  whiteSpace: "nowrap",
                  border: "none",
                  borderRadius: 8,
                  cursor: "pointer",
                  background: active ? "#9670ff" : "transparent",
                  color: active ? "#fdfbf7" : "#a79bd0",
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <label htmlFor="laxu-lend-amount" style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" }}>
              {mode === "deposit" || mode === "withdraw" ? "TOKENS" : "USDG"}
            </label>
            <button
              type="button"
              onClick={() => setAmount(formatUnits(max[mode], decimals))}
              disabled={max[mode] === BigInt(0)}
              style={{
                fontFamily: MONO,
                fontSize: 10.5,
                fontWeight: 600,
                background: "none",
                border: "none",
                padding: 0,
                color: max[mode] === BigInt(0) ? "#6f6596" : "#ffd29c",
                cursor: max[mode] === BigInt(0) ? "default" : "pointer",
              }}
            >
              {mode === "repay" ? "Repay all" : "Max"} {fmt(max[mode], decimals, mode === "deposit" || mode === "withdraw" ? 4 : 2)}
            </button>
          </div>
          <input
            id="laxu-lend-amount"
            value={amount}
            inputMode="decimal"
            placeholder="0.00"
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            style={{
              fontFamily: MONO,
              fontSize: 15,
              padding: "11px 12px",
              borderRadius: 10,
              color: "#fdfbf7",
              background: "rgba(255,255,255,0.07)",
              border: `1px solid ${problem ? "#ff8a8a" : "rgba(255,255,255,0.16)"}`,
              outline: "none",
              width: "100%",
              boxSizing: "border-box",
            }}
          />
          {problem && (
            <div role="status" style={{ fontSize: 11, fontWeight: 600, color: "#ff8a8a" }}>
              {problem}
            </div>
          )}
        </div>

        {blocked && <Note>{blocked}</Note>}

        {sharesToPost > BigInt(0) && !busy && !flow && !blocked && (
          <Note>Posts the {fmt(sharesToPost, decimals, 4)} tokens in your wallet as collateral first, then borrows.</Note>
        )}

        {flow && <BorrowSteps flow={flow} decimals={decimals} />}

        <Action
          label={
            busy
              ? "Confirm in your wallet…"
              : sharesToPost > BigInt(0)
                ? "Deposit & borrow"
                : mode === "deposit"
                  ? "Deposit"
                  : MODES.find((m) => m.key === mode)!.label
          }
          disabled={!canSubmit}
          onClick={() => void submit()}
        />

        {error && (
          <div role="alert" style={{ fontSize: 11.5, fontWeight: 600, lineHeight: 1.45, color: "#ffb4a8" }}>
            {error}
          </div>
        )}

        <Note>
          Borrow at a flat 10% APR. If the health factor falls below 1, anyone can repay part of your loan and take
          collateral at a discount.
        </Note>
      </div>
    </Panel>
  );
}

type Flow = { shares: bigint; amount: bigint; step: BorrowStep; failed: boolean };

const STEP_ORDER: BorrowStep[] = ["approve", "deposit", "borrow"];

/** approve → deposit → borrow, one row each. A skipped approval shows as done once the deposit starts. */
function BorrowSteps({ flow, decimals }: { flow: Flow; decimals: number }) {
  const current = STEP_ORDER.indexOf(flow.step);
  const labels: Record<BorrowStep, string> = {
    approve: "Approve the pool to take your tokens",
    deposit: `Deposit ${fmt(flow.shares, decimals, 4)} tokens as collateral`,
    borrow: `Borrow ${fmt(flow.amount, decimals)} USDG`,
  };
  return (
    <ol aria-label="Borrow steps" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      {STEP_ORDER.map((step, i) => {
        const status = i < current ? "done" : i > current ? "pending" : flow.failed ? "failed" : "active";
        const mark = { done: "✓", active: "…", failed: "✕", pending: String(i + 1) }[status];
        const color = { done: "#5fe3a8", active: "#ffd29c", failed: "#ff8a8a", pending: "#6f6596" }[status];
        return (
          <li
            key={step}
            aria-current={status === "active" ? "step" : undefined}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              fontSize: 11.5,
              fontWeight: 600,
              color: status === "pending" ? "#8c80b8" : "#fdfbf7",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 18,
                height: 18,
                flex: "none",
                borderRadius: 99,
                display: "grid",
                placeItems: "center",
                fontFamily: MONO,
                fontSize: 10,
                border: `1px solid ${color}`,
                color,
              }}
            >
              {mark}
            </span>
            {labels[step]}
          </li>
        );
      })}
    </ol>
  );
}

function HealthGauge({ hf }: { hf: number | null }) {
  const color = hf === null ? "#5fe3a8" : hfColor(hf);
  // Full bar at 2.0 and above; the 1.0 line sits at the halfway mark.
  const fill = hf === null ? 100 : Math.max(3, Math.min(100, (hf / 2) * 100));
  const label = hf === null ? "∞" : hf >= 100 ? "99+" : hf.toFixed(2);
  const word = hf === null ? "No debt" : hf >= 1.5 ? "Healthy" : hf >= 1.1 ? "Watch" : hf >= 1 ? "At risk" : "Liquidatable";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" }}>HEALTH FACTOR</span>
        <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600, color }}>
          {label} <span style={{ fontSize: 11, fontWeight: 600 }}>{word}</span>
        </span>
      </div>
      <div
        role="meter"
        aria-label="Health factor"
        aria-valuemin={0}
        aria-valuemax={2}
        aria-valuenow={hf === null ? 2 : Math.min(hf, 2)}
        aria-valuetext={hf === null ? "No debt" : `${label}, ${word}`}
        style={{ position: "relative", height: 7, borderRadius: 99, background: "rgba(255,255,255,0.1)", overflow: "hidden" }}
      >
        <div style={{ height: "100%", width: `${fill}%`, background: color, borderRadius: 99, transition: "width 0.4s ease" }} />
        <div style={{ position: "absolute", top: 0, bottom: 0, left: "50%", width: 1, background: "rgba(253,251,247,0.5)" }} />
      </div>
    </div>
  );
}
