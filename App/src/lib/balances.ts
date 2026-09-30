"use client";

import { useCallback, useEffect, useState } from "react";
import { erc20Abi, formatEther, formatUnits, type Address } from "viem";
import { publicClient } from "./chain";
import { env } from "./env";
import { useFaucet } from "./faucet";

/** USDG's decimals on every Arcus testnet deployment. */
const USDG_DECIMALS = 6;
const POLL_MS = 20_000;

export type WalletBalances = {
  /** Human decimals; null until the first read lands. */
  usdg: number | null;
  eth: number | null;
  refresh: () => void;
};

/**
 * The wallet's live USDG and ETH, straight from the chain — the trade ticket's
 * pre-checks can't depend on the faucet (which may be switched off). Re-reads
 * every 20s, when a faucet claim reports back, and on `refresh()`.
 */
export function useWalletBalances(address: string | null | undefined): WalletBalances {
  const [loaded, setLoaded] = useState<{ address: string; usdg: number; eth: number } | null>(null);
  const faucetStatus = useFaucet().status;

  const refresh = useCallback(() => {
    if (!address || !env.usdgAddress || !env.rpcUrl) return;
    const owner = address as Address;
    Promise.all([
      publicClient().readContract({ address: env.usdgAddress as Address, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
      publicClient().getBalance({ address: owner }),
    ])
      .then(([usdg, eth]) =>
        setLoaded({ address, usdg: Number(formatUnits(usdg, USDG_DECIMALS)), eth: Number(formatEther(eth)) }),
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
  return { usdg: current?.usdg ?? null, eth: current?.eth ?? null, refresh };
}
