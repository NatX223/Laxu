import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { env } from "./env";

/** Robinhood Chain isn't in `viem/chains`, so it is defined from env. */
export const robinhoodTestnet = defineChain({
  id: env.chainId,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [env.rpcUrl],
      webSocket: env.rpcWsUrl ? [env.rpcWsUrl] : undefined,
    },
  },
  blockExplorers: env.explorerUrl ? { default: { name: "Explorer", url: env.explorerUrl } } : undefined,
});

let client: PublicClient | undefined;

/**
 * Reads and receipt waits. Writes go through the user's own wallet — see
 * walletClient.ts. Built on first use: viem refuses an empty RPC URL, and
 * pages that never touch the chain must still prerender without one.
 */
export function publicClient(): PublicClient {
  if (!client) {
    if (!env.rpcUrl) throw new Error("NEXT_PUBLIC_RPC_URL is not set");
    client = createPublicClient({ chain: robinhoodTestnet, transport: http(env.rpcUrl) }) as PublicClient;
  }
  return client;
}
