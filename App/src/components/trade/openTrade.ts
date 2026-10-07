"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Hash } from "viem";
import {
  ReservationRejected,
  getOpenRequest,
  isUserRejection,
  openPosition,
  reportOpenPayment,
  txErrorMessage,
  type OpenRequest,
} from "@/lib/actions";
import { ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { getWalletClient } from "@/lib/walletClient";

/**
 * Opening a real position from the trade ticket, start to finish:
 *
 *   reserve a slot → the user signs the asset transfer → report it → poll
 *   `GET /positions/open/:id` every 3s until `minted` (then go to the position
 *   page) or `refunded` / `failed`.
 *
 * The request id — and the payment hash once there is one — live in
 * localStorage, so a refresh mid-open picks the polling back up, and a payment
 * that landed but was never reported gets reported then.
 */

export const OPEN_POLL_MS = 3000;
export const BUSY_MESSAGE = "Slots busy, try again in a minute.";

export type OpenParams = {
  market: string;
  direction: "long" | "short";
  leverage: number;
  /** Human amount of the asset as a decimal string. */
  amount: string;
  stopLoss?: string;
  takeProfit?: string;
};

export type OpenPhase =
  | { kind: "idle" }
  /** Asking the backend for a slot. */
  | { kind: "reserving" }
  /** Waiting on the wallet prompt / the transfer's receipt. */
  | { kind: "paying"; id: string; sent: boolean }
  /** Payment handed off; the backend drives the rest. */
  | { kind: "tracking"; id: string; request: OpenRequest | null; reconnecting: boolean }
  /** Nothing was taken — busy, cancelled, or rejected before the transfer. */
  | { kind: "error"; message: string };

type Stored = { id: string; txHash?: Hash };

const storageKey = (wallet: string) => `laxu:open-request:${wallet.toLowerCase()}`;

function load(wallet: string): Stored | null {
  try {
    const raw = window.localStorage.getItem(storageKey(wallet));
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

function save(wallet: string, value: Stored): void {
  try {
    window.localStorage.setItem(storageKey(wallet), JSON.stringify(value));
  } catch {
    // private mode: the open still works, it just won't survive a refresh
  }
}

function clear(wallet: string): void {
  try {
    window.localStorage.removeItem(storageKey(wallet));
  } catch {
    // nothing to clear
  }
}

const TERMINAL = new Set(["minted", "refunded", "failed"]);

export function useOpenTrade(onSettled?: () => void) {
  const { wallet, user } = useSession();
  const router = useRouter();
  const owner = user?.walletAddress ?? null;
  const [ownPhase, setPhase] = useState<OpenPhase>({ kind: "idle" });
  const reportedFor = useRef<string | null>(null);
  const settledRef = useRef(onSettled);
  useEffect(() => {
    settledRef.current = onSettled;
  }, [onSettled]);

  // Resume an open that was in flight when the page went away. `owner` is only
  // known client-side, so reading storage here never differs from the server
  // render. The poll below then writes real progress into `ownPhase`.
  const stored = owner && ownPhase.kind === "idle" ? load(owner) : null;
  const phase: OpenPhase = stored
    ? { kind: "tracking", id: stored.id, request: null, reconnecting: false }
    : ownPhase;

  const trackingId = phase.kind === "tracking" ? phase.id : null;

  useEffect(() => {
    if (!trackingId || !owner) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last: OpenRequest | null = null;

    const poll = async () => {
      try {
        let request = await getOpenRequest(trackingId);
        const stored = load(owner);
        // Paid, but the report never reached the backend (refresh, network).
        // A late payment on a `failed` request is still accepted and refunded.
        if (
          stored?.id === trackingId &&
          stored.txHash &&
          !request.paymentTxHash &&
          (request.status === "awaiting_payment" || request.status === "failed") &&
          reportedFor.current !== stored.txHash
        ) {
          reportedFor.current = stored.txHash;
          try {
            request = await reportOpenPayment(trackingId, stored.txHash);
          } catch (error) {
            reportedFor.current = null;
            console.error("re-reporting the payment failed; retrying", error);
          }
        }
        if (cancelled) return;
        last = request;
        setPhase({ kind: "tracking", id: trackingId, request, reconnecting: false });

        if (TERMINAL.has(request.status)) {
          clear(owner);
          settledRef.current?.();
          if (request.status === "minted" && request.positionTokenAddress) {
            router.push(`/position/${request.positionTokenAddress}`);
          }
          return;
        }
      } catch (error) {
        if (cancelled) return;
        // Not ours / gone: nothing to resume.
        if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
          clear(owner);
          setPhase({ kind: "idle" });
          return;
        }
        // Network trouble: keep the id, keep polling.
        setPhase({ kind: "tracking", id: trackingId, request: last, reconnecting: true });
      }
      if (!cancelled) timer = setTimeout(poll, OPEN_POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [trackingId, owner, router]);

  const start = useCallback(
    async (params: OpenParams) => {
      if (!wallet || !owner) return;
      if (phase.kind === "reserving" || phase.kind === "paying" || phase.kind === "tracking") return;
      setPhase({ kind: "reserving" });
      // Written from the hooks below; read in the catch.
      const progress: { id: string | null; sent: boolean } = { id: null, sent: false };
      try {
        const client = await getWalletClient(wallet);
        const { reservation } = await openPosition(client, params, {
          onReserved: (reservation) => {
            progress.id = reservation.openRequestId;
            save(owner, { id: reservation.openRequestId });
            setPhase({ kind: "paying", id: reservation.openRequestId, sent: false });
          },
          onSubmitted: (reservation, hash) => {
            progress.sent = true;
            save(owner, { id: reservation.openRequestId, txHash: hash });
            setPhase({ kind: "paying", id: reservation.openRequestId, sent: true });
          },
        });
        setPhase({ kind: "tracking", id: reservation.openRequestId, request: null, reconnecting: false });
      } catch (error) {
        const { id, sent } = progress;
        if (id && sent) {
          // The asset left the wallet: never drop the request. Polling reports
          // the payment again if that step is what failed.
          setPhase({ kind: "tracking", id, request: null, reconnecting: true });
          return;
        }
        if (id) clear(owner); // reserved but never paid: the reservation expires on its own
        let message: string;
        if (error instanceof ApiError && error.code === "NO_FREE_SLOT") message = BUSY_MESSAGE;
        else if (isUserRejection(error)) message = "Payment cancelled";
        else if (error instanceof ReservationRejected || error instanceof ApiError) message = error.message;
        else message = txErrorMessage(error);
        setPhase({ kind: "error", message });
      }
    },
    [wallet, owner, phase.kind],
  );

  /** Close the progress view once it has reached an end state (or an error). */
  const dismiss = useCallback(() => {
    setPhase((p) => {
      if (p.kind === "error") return { kind: "idle" };
      if (p.kind === "tracking" && p.request && TERMINAL.has(p.request.status)) return { kind: "idle" };
      return p;
    });
  }, []);

  /** Stop watching a request that is still awaiting a payment the user never sent. */
  const abandon = useCallback(() => {
    if (owner) clear(owner);
    setPhase({ kind: "idle" });
  }, [owner]);

  return { phase, start, dismiss, abandon };
}

export type OpenTrade = ReturnType<typeof useOpenTrade>;
