import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { env } from "./env";

/** Monad Testnet isn't in `viem/chains`, so it is defined from env. */
export const monadTestnet = defineChain({
  id: env.chainId,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: {
      http: [env.rpcUrl],
      webSocket: env.rpcWsUrl ? [env.rpcWsUrl] : undefined,
    },
  },
  blockExplorers: env.explorerUrl ? { default: { name: "Explorer", url: env.explorerUrl } } : undefined,
  // The standard Multicall3 deployment, live on Monad testnet: lets viem fold a page's worth of reads into one call.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

let client: PublicClient | undefined;

/**
 * Reads and receipt waits. Writes go through the user's own wallet — see
 * walletClient.ts. Built on first use: viem refuses an empty RPC URL, and
 * pages that never touch the chain must still prerender without one.
 *
 * The public Monad RPC allows 15 requests a second per IP and a position page
 * reads dozens of fields at once, so contract reads made in the same tick go
 * out as one Multicall3 call and other JSON-RPC calls as one batched request.
 */
export function publicClient(): PublicClient {
  if (!client) {
    if (!env.rpcUrl) throw new Error("NEXT_PUBLIC_RPC_URL is not set");
    client = createPublicClient({
      chain: monadTestnet,
      batch: { multicall: true },
      transport: http(env.rpcUrl, { batch: true }),
    }) as PublicClient;
  }
  return client;
}
