"use client";

import { useCallback, useEffect, useState } from "react";
import { formatUnits, type Address } from "viem";
import {
  BUY_IN_FEE_BPS,
  MAX_NICKNAME_BYTES,
  REQUEST_CANCEL_TIMEOUT_S,
  cancelDepositRequest,
  cancelRedeemRequest,
  claimSettlement,
  closePosition,
  exitStake,
  listPosition,
  readHolderState,
  type HolderState,
} from "@/lib/actions";
import { getClaimed, type PublicPosition } from "@/lib/api";
import { useSession } from "@/lib/session";
import { getWalletClient } from "@/lib/walletClient";
import { MONO, Panel, PanelHead } from "./shared";

/** How often a pending request is re-read while it settles. */
const POLL_MS = 4000;

const nicknameBytes = (value: string) => new TextEncoder().encode(value).length;

const usd = (amount: bigint, decimals: number) =>
  `$${Number(formatUnits(amount, decimals)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Phase = "open" | "closing" | "settling" | "settled";

/** The chain is authoritative; the backend only knows "closing" before close() lands after a liquidation. */
function phaseOf(state: HolderState, live: PublicPosition): Phase {
  if (state.settled) return "settled";
  if (state.closed) return "settling";
  if (state.closeRequested || live.lifecycle === "closing") return "closing";
  return "open";
}

/**
 * What the connected wallet can do with this position, beyond buying in:
 *
 *   - creator, unlisted: List for buy-ins (optional nickname, terms shown first)
 *   - creator holding 100% with no buy-in pending (listed or not): Close
 *   - anyone else holding tokens: Redeem
 *   - a request not yet fulfilled: "Settling on Arcus…", and after 20 minutes
 *     "Cancel and get refund"
 *
 * A fulfilled buy-in mints straight to the wallet and a fulfilled redeem pays
 * straight to it. Once the position closes it runs Closing → Settling →
 * Settled; the backend then pushes each holder's payout, and "Claim $X" is the
 * fallback for anyone the push didn't reach.
 */
export default function HolderActions({
  live,
  refreshKey,
  onDone,
}: {
  live: PublicPosition;
  /** Bumped by the page after a buy-in, so the pending state is re-read at once. */
  refreshKey: number;
  onDone: (message: string) => void;
}) {
  const { wallet } = useSession();
  const token = live.positionTokenAddress as Address;
  const account = wallet?.address as Address | undefined;
  const isCreator = Boolean(account && account.toLowerCase() === live.creator.toLowerCase());

  const [state, setState] = useState<HolderState | null>(null);
  const [busy, setBusy] = useState(false);
  const [nickname, setNickname] = useState("");
  const [confirmingList, setConfirmingList] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  /** USDG already paid to this wallet out of the settlement (the push, or its own claim). */
  const [received, setReceived] = useState<string | null>(null);
  const pool = live.lendingPoolAddress as Address | null;

  const refresh = useCallback(async () => {
    if (!account) return;
    try {
      setState(await readHolderState(token, account, pool));
    } catch (error) {
      console.error("could not read position state", error);
    }
  }, [token, account, pool]);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    readHolderState(token, account, pool)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((error) => console.error("could not read position state", error));
    return () => {
      cancelled = true;
    };
  }, [token, account, pool, refreshKey]);

  const phase = state ? phaseOf(state, live) : "open";
  const claimable = state?.claimable ?? BigInt(0);

  useEffect(() => {
    if (!account || phase !== "settled") return;
    let cancelled = false;
    getClaimed(token, account)
      .then(({ assets }) => {
        if (!cancelled) setReceived(assets);
      })
      .catch((error) => console.error("could not load claimed amount", error));
    return () => {
      cancelled = true;
    };
  }, [token, account, phase, claimable]);

  const pending = Boolean(state && (state.pendingDeposit > BigInt(0) || state.pendingRedeem > BigInt(0)));
  // Closing and settling move on their own; keep re-reading until settled.
  const moving = pending || phase === "closing" || phase === "settling";

  // Poll only while something is settling.
  useEffect(() => {
    if (!moving) return;
    const id = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
      void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [moving, refresh]);

  const run = useCallback(
    async (action: () => Promise<unknown>, message: string) => {
      if (!wallet) return;
      setBusy(true);
      try {
        await action();
        onDone(message);
        await refresh();
      } catch (error) {
        onDone(error instanceof Error ? error.message.split("\n")[0] : "Transaction failed");
      } finally {
        setBusy(false);
      }
    },
    [wallet, onDone, refresh],
  );

  if (!wallet || !state) return null;
  if (phase !== "open") return <ClosedActions state={state} phase={phase} received={received} busy={busy} run={run} wallet={wallet} token={token} />;

  const holdsAll = state.totalSupply > BigInt(0) && state.balance === state.totalSupply;
  const canList = isCreator && !state.listed;
  // Listed or not: once the creator holds everything again, nobody else is in.
  const canClose = isCreator && holdsAll && !state.closeRequested && state.pendingDeposit === BigInt(0);
  const canRedeem = !canClose && state.balance > BigInt(0) && !state.closeRequested;

  const depositCancelAt = state.lastDepositRequestAt + REQUEST_CANCEL_TIMEOUT_S;
  const redeemCancelAt = state.lastRedeemRequestAt + REQUEST_CANCEL_TIMEOUT_S;
  const canCancelDeposit = state.pendingDeposit > BigInt(0) && now >= depositCancelAt;
  const canCancelRedeem = state.pendingRedeem > BigInt(0) && now >= redeemCancelAt;

  if (!canList && !canClose && !canRedeem && !pending && !state.closeRequested) return null;

  const tooLong = nicknameBytes(nickname) > MAX_NICKNAME_BYTES;

  return (
    <Panel>
      <PanelHead label="YOUR POSITION" />
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {pending && (
          <Note>
            Settling on Arcus… {state.pendingDeposit > BigInt(0) ? "Your buy-in" : "Your redeem"} completes
            automatically — no claim needed.
            {!canCancelDeposit && !canCancelRedeem && " If it isn't done in 20 minutes you can cancel it for a refund."}
          </Note>
        )}
        {canCancelDeposit && (
          <Action
            label="Cancel and get refund"
            disabled={busy}
            onClick={() =>
              run(() => getWalletClient(wallet).then((c) => cancelDepositRequest(c, token)), "Buy-in cancelled — USDG refunded")
            }
          />
        )}
        {canCancelRedeem && (
          <Action
            label="Cancel and get refund"
            disabled={busy}
            onClick={() =>
              run(() => getWalletClient(wallet).then((c) => cancelRedeemRequest(c, token)), "Redeem cancelled — tokens returned")
            }
          />
        )}

        {canList &&
          (confirmingList ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <label htmlFor="laxu-nickname" style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" }}>
                NICKNAME (OPTIONAL)
              </label>
              <input
                id="laxu-nickname"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="Set once, can't be changed"
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.07)",
                  border: `1px solid ${tooLong ? "#ff8a8a" : "rgba(255,255,255,0.18)"}`,
                  color: "#fdfbf7",
                  fontFamily: MONO,
                  fontSize: 13,
                  outline: "none",
                }}
              />
              <div style={{ fontSize: 10.5, color: tooLong ? "#ff8a8a" : "#8f85bd" }}>
                {nicknameBytes(nickname)}/{MAX_NICKNAME_BYTES} bytes
              </div>
              <Note>
                Others can buy in with a {BUY_IN_FEE_BPS / 100}% fee paid to you. Once listed, you exit by redeeming
                — or close, once you hold every token again.
              </Note>
              <div style={{ display: "flex", gap: 8 }}>
                <Action label="Back" subtle disabled={busy} onClick={() => setConfirmingList(false)} />
                <Action
                  label="List for buy-ins"
                  disabled={busy || tooLong}
                  onClick={() =>
                    run(
                      () => getWalletClient(wallet).then((c) => listPosition(c, token, nickname.trim())),
                      "Listed — others can buy in now",
                    )
                  }
                />
              </div>
            </div>
          ) : (
            <Action label="List for buy-ins" disabled={busy} onClick={() => setConfirmingList(true)} />
          ))}

        {canClose && !confirmingList && (
          <Action
            label="Close position"
            subtle
            disabled={busy}
            onClick={() =>
              run(() => getWalletClient(wallet).then((c) => closePosition(c, token)), "Close requested — settling on Arcus")
            }
          />
        )}

        {canRedeem && !confirmingList && (
          <Action
            label="Redeem all"
            subtle
            disabled={busy || pending}
            onClick={() =>
              run(
                () => getWalletClient(wallet).then((c) => exitStake(c, token, state.balance)),
                "Redeem requested — settling on Arcus",
              )
            }
          />
        )}
      </div>
    </Panel>
  );
}

/**
 * After close: Closing on Arcus… → Returning funds… → Settled. A buy-in caught
 * by the close is refundable at once (no 20-minute wait); a redeem caught by it
 * is paid out of the settlement with everyone else.
 */
function ClosedActions({
  state,
  phase,
  received,
  busy,
  run,
  wallet,
  token,
}: {
  state: HolderState;
  phase: Exclude<Phase, "open">;
  received: string | null;
  busy: boolean;
  run: (action: () => Promise<unknown>, message: string) => Promise<void>;
  wallet: NonNullable<ReturnType<typeof useSession>["wallet"]>;
  token: Address;
}) {
  const { decimals } = state;
  const holds = state.balance > BigInt(0) || state.pendingRedeem > BigInt(0) || state.inCollateral > BigInt(0);
  const refundable = state.closed && state.pendingDeposit > BigInt(0);
  const receivedAmount = received !== null ? Number(received) : 0;
  if (!holds && !refundable && receivedAmount === 0) return null;

  return (
    <Panel>
      <PanelHead label="YOUR POSITION" />
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {phase === "closing" && <Note>Closing on Arcus…</Note>}
        {phase === "settling" && <Note>Returning funds… Your share is paid out automatically once they arrive.</Note>}

        {refundable && (
          <Action
            label="Cancel and get refund"
            disabled={busy}
            onClick={() =>
              run(() => getWalletClient(wallet).then((c) => cancelDepositRequest(c, token)), "Buy-in cancelled — USDG refunded")
            }
          />
        )}

        {phase === "settled" && receivedAmount > 0 && state.claimable === BigInt(0) && (
          <Note>
            You received{" "}
            <b style={{ color: "#fdfbf7" }}>
              ${receivedAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </b>
            .
          </Note>
        )}

        {phase === "settled" && state.claimable > BigInt(0) && (
          <Action
            label={`Claim ${usd(state.claimable, decimals)}`}
            disabled={busy}
            onClick={() =>
              run(() => getWalletClient(wallet).then((c) => claimSettlement(c, token)), "Claimed — USDG sent to your wallet")
            }
          />
        )}

        {state.inCollateral > BigInt(0) && (
          <Note>
            Your {Number(formatUnits(state.inCollateral, decimals)).toLocaleString()} tokens back a loan.
            {phase === "settled"
              ? ` Repay to claim ${usd(state.collateralClaimable, decimals)}.`
              : " Repay and withdraw them to claim once funds are returned."}
          </Note>
        )}
      </div>
    </Panel>
  );
}

export function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11.5, fontWeight: 500, lineHeight: 1.5, color: "#c2b6e4" }}>{children}</div>;
}

export function Action({
  label,
  onClick,
  disabled,
  subtle,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  subtle?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1,
        textAlign: "center",
        fontFamily: "inherit",
        fontSize: 13,
        fontWeight: 700,
        padding: 12,
        borderRadius: 99,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        border: subtle ? "1px solid rgba(255,255,255,0.18)" : "none",
        color: subtle ? "#fdfbf7" : "#1c1638",
        background: subtle ? "rgba(255,255,255,0.06)" : "linear-gradient(90deg, #b99bff, #ffc98a)",
      }}
    >
      {label}
    </button>
  );
}
