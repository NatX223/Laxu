"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import {
  BUY_IN_FEE_BPS,
  MAX_NICKNAME_BYTES,
  REQUEST_CANCEL_TIMEOUT_S,
  cancelDepositRequest,
  cancelRedeemRequest,
  closePosition,
  exitStake,
  listPosition,
  readHolderState,
  type HolderState,
} from "@/lib/actions";
import type { PublicPosition } from "@/lib/api";
import { useSession } from "@/lib/session";
import { getWalletClient } from "@/lib/walletClient";
import { MONO, Panel, PanelHead } from "./shared";

/** How often a pending request is re-read while it settles. */
const POLL_MS = 4000;

const nicknameBytes = (value: string) => new TextEncoder().encode(value).length;

/**
 * What the connected wallet can do with this position, beyond buying in:
 *
 *   - creator, unlisted: List for buy-ins (optional nickname, terms shown first)
 *   - creator, unlisted, holding 100%: Close
 *   - anyone else holding tokens (or a listed creator): Redeem
 *   - a request not yet fulfilled: "Settling on Arcus…", and after 20 minutes
 *     "Cancel and get refund"
 *
 * There is no claim step: a fulfilled buy-in mints straight to the wallet and
 * a fulfilled redeem pays straight to it, so "settled" is just the pending
 * amount reaching zero.
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

  const refresh = useCallback(async () => {
    if (!account) return;
    try {
      setState(await readHolderState(token, account));
    } catch (error) {
      console.error("could not read position state", error);
    }
  }, [token, account]);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    readHolderState(token, account)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((error) => console.error("could not read position state", error));
    return () => {
      cancelled = true;
    };
  }, [token, account, refreshKey]);

  const pending = Boolean(state && (state.pendingDeposit > BigInt(0) || state.pendingRedeem > BigInt(0)));

  // Poll only while something is settling.
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
      void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [pending, refresh]);

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

  if (!wallet || !state || state.closed) return null;

  const holdsAll = state.totalSupply > BigInt(0) && state.balance === state.totalSupply;
  const canList = isCreator && !state.listed;
  const canClose = isCreator && !state.listed && holdsAll && !state.closeRequested && state.pendingDeposit === BigInt(0);
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

        {state.closeRequested && <Note>Close requested — settling on Arcus.</Note>}

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
                instead of closing.
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

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11.5, fontWeight: 500, lineHeight: 1.5, color: "#c2b6e4" }}>{children}</div>;
}

function Action({
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
