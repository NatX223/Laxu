import { createWalletClient, custom } from "viem";
import type { ConnectedWallet } from "@privy-io/react-auth";
import { robinhoodTestnet } from "./chain";

/**
 * A viem wallet client over the Privy wallet's provider — external or
 * embedded alike — so viem stays the single chain library on both sides.
 * Pass the session's `wallet` -- the one matching the user's registered
 * address, which is what the backend and contracts check against.
 */
export async function getWalletClient(wallet: ConnectedWallet) {
  await wallet.switchChain(robinhoodTestnet.id);
  const provider = await wallet.getEthereumProvider();
  return createWalletClient({
    account: wallet.address as `0x${string}`,
    chain: robinhoodTestnet,
    transport: custom(provider),
  });
}

export type LaxuWalletClient = Awaited<ReturnType<typeof getWalletClient>>;
