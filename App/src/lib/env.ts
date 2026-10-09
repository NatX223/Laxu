/**
 * Every public setting the app reads, in one place. Each `process.env.NEXT_PUBLIC_*`
 * is written out literally because Next inlines them at build time by exact
 * name — a computed `process.env[name]` would come back undefined in the browser.
 */
const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

export const env = {
  privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "",
  /** Dev-only pages (/dev/*) exist only when this is "1"; otherwise they 404. */
  devTools: process.env.NEXT_PUBLIC_DEV_TOOLS === "1",
  /** The Protect-this-loan card (Spec 05b). Off, it is not rendered and nothing else changes. */
  protectionEnabled: process.env.NEXT_PUBLIC_ENABLE_PROTECTION === "true",
  /** The Privy key quorum id (a public id, not a secret) that /dev/privy offers as signer. */
  privySignerId: process.env.NEXT_PUBLIC_PRIVY_SIGNER_ID ?? "",
  /** Monad testnet. */
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143),
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? "",
  rpcWsUrl: process.env.NEXT_PUBLIC_RPC_WS_URL ?? "",
  explorerUrl: (process.env.NEXT_PUBLIC_EXPLORER_URL || "https://testnet.monadvision.com").replace(/\/$/, ""),
  /** Laxu backend base URL. */
  apiUrl,
  /**
   * Perpl's public REST. Perpl answers it with CORS headers for its own origin
   * only, so the browser reads it through `marketDataBase` instead; this is
   * the upstream the backend proxies, and the base a deployment that Perpl
   * allow-lists could point `marketDataBase` at.
   */
  perplApiUrl: (process.env.NEXT_PUBLIC_PERPL_API_URL ?? "https://testnet.perpl.xyz/api").replace(/\/$/, ""),
  /** Perpl's market-data WebSocket host. Refused for browser origins, so unused by default (see lib/perplMarketData.ts). */
  perplWsUrl: (process.env.NEXT_PUBLIC_PERPL_WS_URL ?? "wss://testnet.perpl.xyz").replace(/\/$/, ""),
  /** Perpl's trading app, for "view on Perpl" links. */
  perplAppUrl: (process.env.NEXT_PUBLIC_PERPL_APP_URL ?? "https://testnet.perpl.xyz").replace(/\/$/, ""),
  /**
   * Where the candle, book, ticker and context reads go. Defaults to the Laxu
   * backend's cached proxy (`GET /market-data/v1/...`, same paths as Perpl's
   * REST). Point it at `perplApiUrl` to call Perpl directly.
   */
  marketDataBase: (process.env.NEXT_PUBLIC_MARKET_DATA_BASE || `${apiUrl}/market-data`).replace(/\/$/, ""),
  /** The collateral token's address, for approvals ahead of buy-ins, repays and lending. */
  assetAddress: process.env.NEXT_PUBLIC_ASSET_ADDRESS ?? "",
  /** A public testnet-MON faucet, linked when ours is too low to send gas. */
  monFaucetUrl: process.env.NEXT_PUBLIC_MON_FAUCET_URL || process.env.NEXT_PUBLIC_ETH_FAUCET_URL || "",
};
