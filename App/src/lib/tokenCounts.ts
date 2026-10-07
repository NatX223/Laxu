"use client";

import { useSyncExternalStore } from "react";
import { getListedPositions } from "./api";

/**
 * How many open Laxu position tokens exist per market, from the backend's
 * discovery data (`GET /positions?status=open`, listed positions only: an
 * unlisted position is its creator's alone and isn't public). One shared poll
 * for every reader; null until the first answer, and a market with no entry
 * has none.
 */

export type TokenCounts = {
  /** Base asset -> open listed tokens. */
  byMarket: Record<string, number>;
  /** The discovery page was full, so counts are lower bounds ("100+"). */
  truncated: boolean;
};

const POLL_MS = 60_000;

let counts: TokenCounts | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

async function load() {
  try {
    const { positions, nextCursor } = await getListedPositions({ status: "open", limit: 100 });
    const byMarket: Record<string, number> = {};
    for (const p of positions) byMarket[p.market.baseAsset] = (byMarket[p.market.baseAsset] ?? 0) + 1;
    counts = { byMarket, truncated: nextCursor !== null };
    listeners.forEach((fn) => fn());
  } catch (error) {
    // the cells show a dash rather than a number nobody measured
    console.error("could not load position token counts", error);
  }
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  if (!timer) {
    void load();
    timer = setInterval(() => void load(), POLL_MS);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useTokenCounts(): TokenCounts | null {
  return useSyncExternalStore(
    subscribe,
    () => counts,
    () => null,
  );
}

/** "12", "100+", or a dash while unknown. */
export function tokenCountLabel(all: TokenCounts | null, baseAsset: string): string {
  if (!all) return "—";
  const n = all.byMarket[baseAsset] ?? 0;
  return all.truncated ? `${n}+` : String(n);
}
