"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, claimFaucet, getFaucetConfig, getFaucetStatus, type FaucetStatus } from "./api";
import { useSession } from "./session";

/**
 * "Get test funds" state, shared by every faucet button on the page (header,
 * trade-ticket nudge) so they all show the same sending/cooldown state.
 *
 * `status.balances` are the user's live on-chain asset and MON balances; a
 * claim refreshes them, and so does coming back to the tab.
 */

export type FaucetPhase =
  | { kind: "idle" }
  | { kind: "sending" }
  /** `received`: what the claim actually delivered, human decimal; null when it couldn't be measured. */
  | { kind: "sent"; nativeSkipped: boolean; received: string | null }
  | { kind: "error"; message: string };

type Faucet = {
  /** Null until `/faucet/config` answers; false hides every faucet button. */
  enabled: boolean | null;
  /** Signed in and loaded; null otherwise. */
  status: FaucetStatus | null;
  phase: FaucetPhase;
  claim: () => Promise<void>;
  /** Clears a sent/error message. */
  dismiss: () => void;
  refresh: () => void;
};

/** A plain success message clears itself; the MON-skipped note waits to be read. */
const SENT_MS = 8000;
/** The claim returns once the transfer is sent; the balance can lag it by a block or two. */
const RECEIPT_CHECKS = 4;
const RECEIPT_WAIT_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How much of the asset a claim delivered: the amount the backend reports if
 * it does, otherwise the rise in the wallet's balance (the external faucet and
 * the fallback transfer pay different amounts, so nothing is assumed).
 */
async function receivedAmount(before: number | null, reported: string | undefined): Promise<string | null> {
  if (reported) return reported;
  if (before === null) return null;
  for (let i = 0; i < RECEIPT_CHECKS; i++) {
    const delta = Number((await getFaucetStatus().catch(() => null))?.balances.asset ?? NaN) - before;
    if (Number.isFinite(delta) && delta > 0) return String(Math.round(delta * 100) / 100);
    await sleep(RECEIPT_WAIT_MS);
  }
  return null;
}

const IDLE: FaucetPhase = { kind: "idle" };

const FaucetContext = createContext<Faucet | null>(null);

export function FaucetProvider({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const wallet = user?.walletAddress ?? null;
  // Each tagged with the wallet it belongs to, so signing out or switching
  // account drops the last user's without a reset effect.
  const [loaded, setLoaded] = useState<{ wallet: string; status: FaucetStatus } | null>(null);
  const [claimed, setClaimed] = useState<{ wallet: string; phase: FaucetPhase } | null>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const status = wallet && loaded?.wallet === wallet ? loaded.status : null;
  const phase: FaucetPhase = wallet && claimed?.wallet === wallet ? claimed.phase : IDLE;

  useEffect(() => {
    getFaucetConfig()
      .then((config) => {
        setEnabled(config.enabled);
      })
      .catch((error) => {
        console.error("GET /faucet/config failed", error);
        setEnabled(false);
      });
  }, []);

  const refresh = useCallback(() => {
    if (!wallet || !enabled) return;
    getFaucetStatus()
      .then((next) => setLoaded({ wallet, status: next }))
      .catch((error) => {
        if (error instanceof ApiError && error.code === "FAUCET_DISABLED") setEnabled(false);
        else console.error("GET /faucet/status failed", error);
      });
  }, [wallet, enabled]);

  // Signed in, or switched account.
  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  useEffect(() => () => {
    if (sentTimer.current) clearTimeout(sentTimer.current);
  }, []);

  const claim = useCallback(async () => {
    if (!wallet || phase.kind === "sending") return;
    if (sentTimer.current) clearTimeout(sentTimer.current);
    const setPhase = (next: FaucetPhase) => setClaimed({ wallet, phase: next });
    const coolDown = (nextClaimAt: string | null) =>
      setLoaded((l) => (l?.wallet === wallet ? { wallet, status: { ...l.status, canClaim: false, nextClaimAt } } : l));

    const before = status ? Number(status.balances.asset) : null;
    setPhase({ kind: "sending" });
    try {
      const result = await claimFaucet();
      coolDown(result.nextClaimAt);
      const received = await receivedAmount(Number.isFinite(before) ? before : null, result.assetAmount);
      setPhase({ kind: "sent", nativeSkipped: result.nativeSkipped, received });
      if (!result.nativeSkipped) sentTimer.current = setTimeout(() => setPhase({ kind: "idle" }), SENT_MS);
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        // Already claimed (another tab, or the IP limit): show the cooldown.
        coolDown((error.details as { nextClaimAt?: string } | undefined)?.nextClaimAt ?? null);
        setPhase({ kind: "idle" });
      } else if (error instanceof ApiError && error.code === "FAUCET_DISABLED") {
        setEnabled(false);
        setPhase({ kind: "idle" });
      } else {
        setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
    // New balances either way: a failure can still have landed the asset.
    refresh();
  }, [wallet, phase.kind, refresh, status]);

  const dismiss = useCallback(() => {
    if (sentTimer.current) clearTimeout(sentTimer.current);
    setClaimed((c) => (c && c.phase.kind !== "sending" ? { ...c, phase: { kind: "idle" } } : c));
  }, []);

  const value = useMemo<Faucet>(
    () => ({ enabled, status, phase, claim, dismiss, refresh }),
    [enabled, status, phase, claim, dismiss, refresh],
  );

  return <FaucetContext.Provider value={value}>{children}</FaucetContext.Provider>;
}

const OFF: Faucet = {
  enabled: false,
  status: null,
  phase: IDLE,
  claim: async () => {},
  dismiss: () => {},
  refresh: () => {},
};

/** Outside a FaucetProvider (no Privy configured) the faucet is simply off. */
export function useFaucet(): Faucet {
  return useContext(FaucetContext) ?? OFF;
}
