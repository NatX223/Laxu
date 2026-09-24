"use client";

import { useCallback, useEffect, useState } from "react";
import { formatUnits, type Address } from "viem";
import {
  clearTriggers,
  readHolderState,
  resetTriggersToDefault,
  setTriggers,
  type HolderState,
} from "@/lib/actions";
import { getHolderTriggers, type HolderTriggers, type PublicPosition } from "@/lib/api";
import { useSession } from "@/lib/session";
import { getWalletClient } from "@/lib/walletClient";
import { Action, Note } from "./HolderActions";
import { MONO, Panel, PanelHead } from "./shared";

const LABEL: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" };

const DECIMAL = /^\d+(\.\d+)?$/;

const shownPrice = (value: string | null) =>
  value === null
    ? "—"
    : `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;

/**
 * The same rule the contract enforces in setTriggers: a long's stop loss sits
 * below the mark and its take profit above; a short's the other way round. A
 * level already crossed is rejected, since it would fire at once.
 */
function levelProblem(side: "long" | "short", sl: string, tp: string, mark: number | null): string | null {
  for (const [name, value] of [
    ["Stop loss", sl],
    ["Take profit", tp],
  ] as const) {
    if (value && !DECIMAL.test(value)) return `${name} must be a price, e.g. 1900`;
  }
  if (mark === null) return null;
  const long = side === "long";
  if (sl && (long ? Number(sl) >= mark : Number(sl) <= mark)) {
    return `Stop loss must be ${long ? "below" : "above"} the current price (${shownPrice(String(mark))})`;
  }
  if (tp && (long ? Number(tp) <= mark : Number(tp) >= mark)) {
    return `Take profit must be ${long ? "above" : "below"} the current price (${shownPrice(String(mark))})`;
  }
  return null;
}

/** A stop loss beyond the liquidation price never gets the chance to fire. */
function pastLiquidation(side: "long" | "short", sl: string, liq: string | null): boolean {
  if (!sl || !liq || !DECIMAL.test(sl)) return false;
  return side === "long" ? Number(sl) <= Number(liq) : Number(sl) >= Number(liq);
}

/**
 * "Your SL / TP" — the connected wallet's own stop loss and take profit on this
 * position. The creator's levels are everyone's defaults; any holder can set
 * their own, remove them, or go back to the defaults. A triggered level exits
 * only this wallet's tokens, at NAV; everyone else stays in.
 *
 * Shown to anyone holding, and on a listed position to anyone about to buy in
 * (levels can be set before the buy-in settles).
 */
export default function TriggersPanel({
  live,
  refreshKey,
  onDone,
}: {
  live: PublicPosition;
  refreshKey: number;
  onDone: (message: string) => void;
}) {
  const { wallet } = useSession();
  const token = live.positionTokenAddress as Address;
  const account = wallet?.address as Address | undefined;
  const pool = live.lendingPoolAddress as Address | null;
  const side = live.direction;

  const [triggers, setTriggerState] = useState<HolderTriggers | null>(null);
  const [holder, setHolder] = useState<HolderState | null>(null);
  const [editing, setEditing] = useState(false);
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!account) return;
    const [next, state] = await Promise.all([getHolderTriggers(token, account), readHolderState(token, account, pool)]);
    setTriggerState(next);
    setHolder(state);
  }, [token, account, pool]);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    Promise.all([getHolderTriggers(token, account), readHolderState(token, account, pool)])
      .then(([next, state]) => {
        if (cancelled) return;
        setTriggerState(next);
        setHolder(state);
      })
      .catch((error) => console.error("could not load SL/TP", error));
    return () => {
      cancelled = true;
    };
  }, [token, account, pool, refreshKey]);

  const run = useCallback(
    async (action: () => Promise<unknown>, message: string) => {
      if (!wallet) return;
      setBusy(true);
      try {
        await action();
        setEditing(false);
        onDone(message);
        // The indexer mirrors the event a moment after the receipt.
        setTimeout(() => void load().catch(() => undefined), 2500);
      } catch (error) {
        onDone(error instanceof Error ? error.message.split("\n")[0] : "Transaction failed");
      } finally {
        setBusy(false);
      }
    },
    [wallet, onDone, load],
  );

  if (!wallet || !triggers || !holder || live.lifecycle !== "open") return null;
  const holds = holder.balance > BigInt(0) || holder.pendingDeposit > BigInt(0) || holder.inCollateral > BigInt(0);
  if (!holds && !live.listed) return null;

  const hasLevels = triggers.stopLoss !== null || triggers.takeProfit !== null;
  const badge = triggers.usingDefault ? (hasLevels ? "DEFAULT" : "NONE") : "CUSTOM";
  const canReset = !triggers.usingDefault && triggers.defaultsActive;
  const mark = triggers.markPrice === null ? null : Number(triggers.markPrice);
  const problem = editing ? levelProblem(side, sl.trim(), tp.trim(), mark) : null;
  const liqWarning = editing && pastLiquidation(side, sl.trim(), triggers.estLiquidationPrice);
  const fmtShares = (shares: bigint) => Number(formatUnits(shares, holder.decimals)).toLocaleString();

  const startEdit = () => {
    setSl(triggers.stopLoss ?? "");
    setTp(triggers.takeProfit ?? "");
    setEditing(true);
  };

  return (
    <Panel>
      <PanelHead label="YOUR SL / TP">
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.1em",
            padding: "3px 9px",
            borderRadius: 99,
            color: badge === "CUSTOM" ? "#1c1638" : "#d5c6ff",
            background: badge === "CUSTOM" ? "#ffc98a" : "rgba(255,255,255,0.08)",
          }}
        >
          {badge}
        </span>
      </PanelHead>
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {editing ? (
          <>
            <LevelInput id="laxu-sl" label="STOP LOSS" value={sl} onChange={setSl} />
            <LevelInput id="laxu-tp" label="TAKE PROFIT" value={tp} onChange={setTp} />
            {problem && <div style={{ fontSize: 11, fontWeight: 600, color: "#ff8a8a" }}>{problem}</div>}
            {liqWarning && (
              <div style={{ fontSize: 11, fontWeight: 600, color: "#ffb765" }}>
                Arcus would liquidate before your stop triggers (est. {shownPrice(triggers.estLiquidationPrice)}).
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <Action label="Back" subtle disabled={busy} onClick={() => setEditing(false)} />
              <Action
                label="Save"
                disabled={busy || Boolean(problem) || (!sl.trim() && !tp.trim())}
                onClick={() =>
                  run(
                    () => getWalletClient(wallet).then((c) => setTriggers(c, token, { stopLoss: sl, takeProfit: tp })),
                    "Your SL / TP is set",
                  )
                }
              />
            </div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 1, background: "rgba(255,255,255,0.09)", borderRadius: 10, overflow: "hidden" }}>
              {[
                { k: "Stop loss", v: triggers.stopLoss, c: "#ff8a8a" },
                { k: "Take profit", v: triggers.takeProfit, c: "#5fe3a8" },
              ].map((row) => (
                <div
                  key={row.k}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 11px", background: "#241c46" }}
                >
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#a79bd0" }}>{row.k}</div>
                  <div style={{ fontFamily: MONO, fontSize: 12, color: row.v === null ? "#7b719e" : row.c }}>{shownPrice(row.v)}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Action label="Edit" disabled={busy} onClick={startEdit} />
              {hasLevels && (
                <Action
                  label="Remove"
                  subtle
                  disabled={busy}
                  onClick={() => run(() => getWalletClient(wallet).then((c) => clearTriggers(c, token)), "SL / TP removed")}
                />
              )}
            </div>
            {canReset && (
              <Action
                label="Reset to default"
                subtle
                disabled={busy}
                onClick={() =>
                  run(() => getWalletClient(wallet).then((c) => resetTriggersToDefault(c, token)), "Back on the creator's SL / TP")
                }
              />
            )}
          </>
        )}

        <Note>
          Checked every minute; executes at market price, so fills can land past your level in fast moves. Only your
          tokens exit — everyone else stays in.
        </Note>
        {holder.inCollateral > BigInt(0) && (
          <Note>
            SL/TP covers the {fmtShares(holder.balance)} tokens in your wallet, not the {fmtShares(holder.inCollateral)} in
            your loan.
          </Note>
        )}
      </div>
    </Panel>
  );
}

function LevelInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label htmlFor={id} style={LABEL}>
        {label}
      </label>
      <input
        id={id}
        value={value}
        inputMode="decimal"
        placeholder="None"
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
        style={{
          padding: "10px 12px",
          borderRadius: 10,
          background: "rgba(255,255,255,0.07)",
          border: "1px solid rgba(255,255,255,0.18)",
          color: "#fdfbf7",
          fontFamily: MONO,
          fontSize: 13,
          outline: "none",
        }}
      />
    </div>
  );
}
