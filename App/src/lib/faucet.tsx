"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, claimFaucet, getFaucetConfig, getFaucetStatus, type FaucetStatus } from "./api";
import { useSession } from "./session";

/**
 * "Get test funds" state, shared by every faucet button on the page (header,
 * trade-ticket nudge) so they all show the same sending/cooldown state.
 *
 * `status.balances` are the user's live on-chain USDG/ETH; a claim refreshes
 * them, and so does coming back to the tab.
 */

export type FaucetPhase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; ethSkipped: boolean }
  | { kind: "error"; message: string };

type Faucet = {
  /** Null until `/faucet/config` answers; false hides every faucet button. */
  enabled: boolean | null;
  /** Human USDG per claim, e.g. "1000". */
  usdgAmount: string | null;
  /** Signed in and loaded; null otherwise. */
  status: FaucetStatus | null;
  phase: FaucetPhase;
  claim: () => Promise<void>;
  /** Clears a sent/error message. */
  dismiss: () => void;
  refresh: () => void;
};

/** A plain success message clears itself; the ETH-skipped note waits to be read. */
const SENT_MS = 8000;

const IDLE: FaucetPhase = { kind: "idle" };

const FaucetContext = createContext<Faucet | null>(null);

export function FaucetProvider({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [usdgAmount, setUsdgAmount] = useState<string | null>(null);
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
        setUsdgAmount(config.usdgAmount);
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

    setPhase({ kind: "sending" });
    try {
      const result = await claimFaucet();
      setPhase({ kind: "sent", ethSkipped: result.ethSkipped });
      coolDown(result.nextClaimAt);
      if (!result.ethSkipped) sentTimer.current = setTimeout(() => setPhase({ kind: "idle" }), SENT_MS);
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
    // New balances either way: a failure can still have landed the USDG.
    refresh();
  }, [wallet, phase.kind, refresh]);

  const dismiss = useCallback(() => {
    if (sentTimer.current) clearTimeout(sentTimer.current);
    setClaimed((c) => (c && c.phase.kind !== "sending" ? { ...c, phase: { kind: "idle" } } : c));
  }, []);

  const value = useMemo<Faucet>(
    () => ({ enabled, usdgAmount: status?.usdgAmount ?? usdgAmount, status, phase, claim, dismiss, refresh }),
    [enabled, usdgAmount, status, phase, claim, dismiss, refresh],
  );

  return <FaucetContext.Provider value={value}>{children}</FaucetContext.Provider>;
}

const OFF: Faucet = {
  enabled: false,
  usdgAmount: null,
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
