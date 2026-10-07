"use client";

import { useSyncExternalStore } from "react";
import { erc20Abi, formatUnits, parseUnits, type Address } from "viem";
import { publicClient } from "./chain";
import { env } from "./env";

/**
 * The collateral token's symbol and decimals, read from the contract once and
 * cached — never hard-coded, so the app follows whichever asset the deployment
 * settles in. `useAsset()` for labels; `getAsset()` where an amount is about
 * to be parsed or sent, so a placeholder can never scale money.
 */

export type Asset = { symbol: string; decimals: number };

/** Shown for the instant before the first read lands. */
const PENDING: Asset = { symbol: "…", decimals: 6 };

let loaded: Asset | null = null;
let inflight: Promise<Asset> | null = null;
const listeners = new Set<() => void>();

/** The asset, from the chain on first call, cached after. Rejects if the RPC does. */
export function getAsset(): Promise<Asset> {
  if (loaded) return Promise.resolve(loaded);
  if (!env.assetAddress) return Promise.reject(new Error("NEXT_PUBLIC_ASSET_ADDRESS is not set"));
  inflight ??= Promise.all([
    publicClient().readContract({ address: env.assetAddress as Address, abi: erc20Abi, functionName: "symbol" }),
    publicClient().readContract({ address: env.assetAddress as Address, abi: erc20Abi, functionName: "decimals" }),
  ])
    .then(([symbol, decimals]) => {
      loaded = { symbol, decimals };
      listeners.forEach((fn) => fn());
      return loaded;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  if (!loaded && env.assetAddress && env.rpcUrl) getAsset().catch((error) => console.error("could not read the asset token", error));
  return () => {
    listeners.delete(fn);
  };
}

/** `{ symbol, decimals }` of the collateral token; a placeholder until the first read lands. */
export function useAsset(): Asset {
  return useSyncExternalStore(
    subscribe,
    () => loaded ?? PENDING,
    () => PENDING,
  );
}

/** Base units -> human number. */
export const fromAssetUnits = (units: bigint, decimals: number) => Number(formatUnits(units, decimals));

/** Human decimal string -> base units. */
export const toAssetUnits = (human: string, decimals: number) => parseUnits(human, decimals);
