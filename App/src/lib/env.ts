/**
 * Every public setting the app reads, in one place. Each `process.env.NEXT_PUBLIC_*`
 * is written out literally because Next inlines them at build time by exact
 * name — a computed `process.env[name]` would come back undefined in the browser.
 */
export const env = {
  privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "",
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 0),
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? "",
  rpcWsUrl: process.env.NEXT_PUBLIC_RPC_WS_URL ?? "",
  explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL ?? "",
  /** Laxu backend base URL. */
  apiUrl: (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, ""),
  /** Perpl public market data — candles over REST, live bars over WebSocket. */
  perplApiUrl: (process.env.NEXT_PUBLIC_PERPL_API_URL ?? "https://testnet.perpl.xyz/api").replace(/\/$/, ""),
  perplWsUrl: process.env.NEXT_PUBLIC_PERPL_WS_URL ?? "wss://testnet.perpl.xyz/v1/ws",
  /** Market logos, used only when the backend is unreachable (it resolves logos itself). */
  perplBrandingUrl: (process.env.NEXT_PUBLIC_PERPL_BRANDING_URL ?? "https://branding.testnet.perpl.xyz").replace(/\/$/, ""),
  /** Asset address, for approvals ahead of buy-ins, repays and lending. */
  assetAddress: process.env.NEXT_PUBLIC_ASSET_ADDRESS ?? "",
  /** A public testnet-MON faucet, linked when ours is too low to send gas. */
  monFaucetUrl: process.env.NEXT_PUBLIC_MON_FAUCET_URL ?? "",
};
