"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { positionTokenAbi } from "@/lib/abi.generated";
import { useAsset } from "@/lib/asset";
import { publicClient } from "@/lib/chain";
import type { Position } from "./data";

/**
 * A position's value and P&L straight from its token: NAV per share against
 * the genesis 1.0 (`currentPnLBps()`), so funding and fees are in it, unlike
 * a mark-minus-entry guess. Position-level figures, not the viewer's share.
 */

export type PositionNav = {
  /** NAV against 1.0, percent. */
  pnlPct: number;
  /** (NAV − 1) × supply, in the asset. */
  pnlAbs: number;
  /** `totalAssets()`, in the asset: what the position is worth. */
  equity: number;
};

const POLL_MS = 15_000;

async function readNav(token: Address, decimals: number): Promise<PositionNav> {
  const read = <T>(functionName: string) =>
    publicClient().readContract({ address: token, abi: positionTokenAbi, functionName } as never) as Promise<T>;
  const [pnlBps, totalAssets, supply, nav] = await Promise.all([
    read<bigint>("currentPnLBps"),
    read<bigint>("totalAssets"),
    read<bigint>("totalSupply"),
    read<bigint>("navPerShare"),
  ]);
  const unit = 10 ** decimals;
  return {
    pnlPct: Number(pnlBps) / 100,
    pnlAbs: ((Number(nav) / 1e18 - 1) * Number(supply)) / unit,
    equity: Number(totalAssets) / unit,
  };
}

/** Polled NAV for each of `positions`, keyed by lowercase token address. */
export function usePositionNavs(positions: Position[]): Record<string, PositionNav> {
  const { decimals } = useAsset();
  const [navs, setNavs] = useState<Record<string, PositionNav>>({});
  const key = positions.map((p) => p.addr.toLowerCase()).join(",");

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const load = () =>
      Promise.all(
        key.split(",").map((addr) =>
          readNav(addr as Address, decimals).then(
            (nav) => [addr, nav] as const,
            () => null,
          ),
        ),
      ).then((rows) => {
        if (cancelled) return;
        setNavs((prev) => ({ ...prev, ...Object.fromEntries(rows.filter((r) => r !== null)) }));
      });
    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [key, decimals]);

  return navs;
}
