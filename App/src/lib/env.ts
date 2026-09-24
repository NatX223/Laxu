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
  /** Arcus public market data — candles over REST, live bars over WebSocket. */
  arcusApiUrl: (process.env.NEXT_PUBLIC_ARCUS_API_URL ?? "https://api.testnet.arcus.xyz").replace(/\/$/, ""),
  arcusWsUrl: process.env.NEXT_PUBLIC_ARCUS_WS_URL ?? "wss://api.testnet.arcus.xyz/v1/ws",
  /** Market logos, used only when the backend is unreachable (it resolves logos itself). */
  arcusBrandingUrl: (process.env.NEXT_PUBLIC_ARCUS_BRANDING_URL ?? "https://branding.testnet.arcus.xyz").replace(/\/$/, ""),
  /** USDG, for approvals ahead of buy-ins, repays and lending. */
  usdgAddress: process.env.NEXT_PUBLIC_USDG_ADDRESS ?? "",
};
