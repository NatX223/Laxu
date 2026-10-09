"use client";

import { useEffect, useState } from "react";
import { getHealth } from "./api";

/**
 * The Laxu fee (Perpl builder fee) charged on each venue order, as a percent
 * of notional, from the backend's /health. 0 while builder fees are off, which
 * is the default: callers show nothing then. Fetched once per page load.
 */
let cached: Promise<number> | null = null;

function load(): Promise<number> {
  cached ??= getHealth()
    .then((h) => (typeof h.laxuFeePct === "number" && h.laxuFeePct > 0 ? h.laxuFeePct : 0))
    .catch(() => {
      cached = null;
      return 0;
    });
  return cached;
}

export function useLaxuFeePct(): number {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void load().then((value) => !cancelled && setPct(value));
    return () => {
      cancelled = true;
    };
  }, []);
  return pct;
}

/** "0.05%" */
export const laxuFeeLabel = (pct: number) => `${pct.toLocaleString("en-US", { maximumFractionDigits: 3 })}%`;
