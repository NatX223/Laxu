"use client";

import { useCallback, useEffect, useState } from "react";
import { erc20Abi, formatEther, formatUnits, type Address } from "viem";
import { getAsset } from "./asset";
import { publicClient } from "./chain";
import { env } from "./env";
import { useFaucet } from "./faucet";

const POLL_MS = 20_000;

export type WalletBalances = {
  /** The collateral token, human decimals; null until the first read lands. */
  asset: number | null;
  /** Native MON (gas), human decimals; null until the first read lands. */
  mon: number | null;
  refresh: () => void;
};

/**
 * The wallet's live collateral-token and MON balances, straight from the chain
 * — the trade ticket's pre-checks can't depend on the faucet (which may be
 * switched off). Re-reads every 20s, when a faucet claim reports back, and on
 * `refresh()`.
 */
export function useWalletBalances(address: string | null | undefined): WalletBalances {
  const [loaded, setLoaded] = useState<{ address: string; asset: number; mon: number } | null>(null);
  const faucetStatus = useFaucet().status;

  const refresh = useCallback(() => {
    if (!address || !env.assetAddress || !env.rpcUrl) return;
    const owner = address as Address;
    Promise.all([
      getAsset(),
      publicClient().readContract({ address: env.assetAddress as Address, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
      publicClient().getBalance({ address: owner }),
    ])
      .then(([asset, held, mon]) =>
        setLoaded({ address, asset: Number(formatUnits(held, asset.decimals)), mon: Number(formatEther(mon)) }),
      )
      .catch((error) => console.error("could not read wallet balances", error));
  }, [address]);

  // Signed in, switched account, or the faucet just sent funds.
  useEffect(() => {
    refresh();
  }, [refresh, faucetStatus]);

  useEffect(() => {
    if (!address) return;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [address, refresh]);

  const current = address && loaded?.address === address ? loaded : null;
  return { asset: current?.asset ?? null, mon: current?.mon ?? null, refresh };
}
