"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLogin, usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { ApiError, apiFetch, type LaxuUser } from "./api";

/**
 * Privy login state joined to the backend's user row.
 *
 * After every login this calls `POST /users/me` once: it creates the row on a
 * first visit (wallet resolved server-side, default tag, gas drip) and is a
 * plain read after that. An email user's embedded wallet is created a beat
 * after login, so `WALLET_NOT_READY` is retried briefly.
 */

type Session = {
  /** Privy has initialised; nothing wallet-dependent renders before this. */
  ready: boolean;
  authenticated: boolean;
  /** Null until `POST /users/me` has answered. */
  user: LaxuUser | null;
  /**
   * Signed in, but `POST /users/me` gave up (backend down, or the wallet never
   * appeared). Without it the header would wait on `user` forever.
   */
  userFailed: boolean;
  /**
   * The wallet the backend knows this user by (`user.walletAddress`) — never
   * just `wallets[0]`, which can be a different linked wallet. Payments and
   * on-chain requests are checked against this address, so signing with any
   * other wallet would be rejected (or strand the funds). Null until the user
   * row has loaded and Privy has that wallet connected.
   */
  wallet: ConnectedWallet | null;
  login: () => void;
  /**
   * Sign in (or up — Privy's modal does both), then go to `href`. Already
   * signed in, it just navigates. Closing the modal cancels the navigation.
   */
  loginThen: (href: string) => void;
  logout: () => Promise<void>;
  setUser: (user: LaxuUser) => void;
};

const SessionContext = createContext<Session | null>(null);

const WALLET_RETRIES = 6;
const WALLET_RETRY_MS = 1500;

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, logout, user: privyUser } = usePrivy();
  const { wallets } = useWallets();
  const [user, setUser] = useState<LaxuUser | null>(null);
  /** The Privy id whose `POST /users/me` gave up; any other id starts clean. */
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const router = useRouter();

  // Where to go once a CTA-triggered login completes. onComplete fires after
  // the embedded wallet exists too, so the destination can use it at once.
  const pendingHref = useRef<string | null>(null);
  const { login } = useLogin({
    onComplete: () => {
      const href = pendingHref.current;
      pendingHref.current = null;
      if (href) router.push(href);
    },
    onError: () => {
      pendingHref.current = null;
    },
  });

  const loginThen = useCallback(
    (href: string) => {
      if (authenticated) {
        router.push(href);
        return;
      }
      pendingHref.current = href;
      login();
    },
    [authenticated, login, router],
  );

  const privyId = authenticated ? (privyUser?.id ?? null) : null;

  useEffect(() => {
    if (!ready || !privyId) return;
    let cancelled = false;

    (async () => {
      for (let attempt = 0; attempt < WALLET_RETRIES && !cancelled; attempt++) {
        try {
          const me = await apiFetch<LaxuUser>("/users/me", { auth: true, method: "POST" });
          if (!cancelled) setUser(me);
          return;
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "WALLET_NOT_READY") {
            console.error("POST /users/me failed", error);
            if (!cancelled) setFailedFor(privyId);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, WALLET_RETRY_MS));
        }
      }
      if (!cancelled) setFailedFor(privyId);
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, privyId]);

  const signOut = useCallback(async () => {
    await logout();
    setUser(null);
  }, [logout]);

  const value = useMemo<Session>(
    () => ({
      ready,
      authenticated,
      user: privyId ? user : null,
      userFailed: privyId !== null && failedFor === privyId,
      wallet:
        authenticated && privyId && user
          ? (wallets.find((w) => w.address.toLowerCase() === user.walletAddress.toLowerCase()) ?? null)
          : null,
      login: () => login(),
      loginThen,
      logout: signOut,
      setUser,
    }),
    [ready, authenticated, privyId, user, failedFor, wallets, login, loginThen, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

const NO_AUTH: Session = {
  ready: true,
  authenticated: false,
  user: null,
  userFailed: false,
  wallet: null,
  login: () => console.warn("Login is unavailable: NEXT_PUBLIC_PRIVY_APP_ID is not set"),
  // no auth configured: the CTA still takes you where it says
  loginThen: (href) => window.location.assign(href),
  logout: async () => {},
  setUser: () => {},
};

/**
 * Stands in for Privy when no app id is configured, so the public screens
 * (discovery, positions, charts) still render — and prerender at build time,
 * where PrivyProvider would reject an empty id.
 */
export function NoAuthSessionProvider({ children }: { children: React.ReactNode }) {
  return <SessionContext.Provider value={NO_AUTH}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <Providers>");
  return session;
}
