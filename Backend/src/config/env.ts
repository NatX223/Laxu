import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Env var ${name} is not a number: ${raw}`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export const config = {
  port: num("PORT", 3000),
  nodeEnv: optional("NODE_ENV", "development"),
  logLevel: optional("LOG_LEVEL", "info"),

  // --- Chain ---------------------------------------------------------------
  rpcUrl: optional("RPC_URL"),
  chainId: num("CHAIN_ID", 0),
  positionTokenFactoryAddress: optional("POSITION_TOKEN_FACTORY_ADDRESS"),
  /// Backfill start point when the indexer checkpoint doesn't exist yet.
  /// Kept as a string and parsed with BigInt() at the call site -- a block
  /// number can exceed Number's safe integer range on some chains.
  positionTokenFactoryDeployBlock: optional("POSITION_TOKEN_FACTORY_DEPLOY_BLOCK", "0"),
  usdgAddress: optional("USDG_ADDRESS"),
  /// The one backend key for every Laxu contract write: createPosition,
  /// createPool, applyReport, fulfil*, close. PositionTokenFactory passes its
  /// `deployer` through as each token's `arcusOperator`, so the two roles are
  /// always the same address.
  operatorPrivateKey: optional("OPERATOR_PRIVATE_KEY"),

  lendingPoolFactoryAddress: optional("LENDING_POOL_FACTORY_ADDRESS"),
  /// Backfill start point for LendingPoolFactory.PoolCreated + per-pool
  /// CollateralDeposited/Borrowed, same reasoning as the position token
  /// factory's own deploy-block env var.
  lendingPoolFactoryDeployBlock: optional("LENDING_POOL_FACTORY_DEPLOY_BLOCK", "0"),
  /// liquidate() is permissionless -- this wallet holds none of the operator's
  /// roles, only a USDG balance and pool approvals.
  liquidatorPrivateKey: optional("LIQUIDATOR_PRIVATE_KEY"),

  // --- Arcus ---------------------------------------------------------------
  arcusApiBaseUrl: optional("ARCUS_API_BASE_URL", "https://api.testnet.arcus.xyz"),
  arcusWsUrl: optional("ARCUS_WS_URL", "wss://api.testnet.arcus.xyz/v1/ws"),
  /// Host for market logos, `{base}/markets/branding/{BASE_ASSET}.png` -- the
  /// fallback when the metadata endpoint has no logo. Differs per environment.
  arcusBrandingBaseUrl: optional("ARCUS_BRANDING_BASE_URL", "https://branding.testnet.arcus.xyz"),
  /// Slippage bound on the protective MARKET price, in basis points. Arcus
  /// rejects anything beyond 10% of mark, so this must stay under 1000.
  arcusSlippageBps: num("ARCUS_SLIPPAGE_BPS", 900),
  /// goodTilTime is mandatory on every order, including IOC, and must sit at
  /// least one month ahead. Two months of headroom absorbs clock skew.
  arcusGoodTilDays: num("ARCUS_GOOD_TIL_DAYS", 60),
  arcusRequestTimeoutMs: num("ARCUS_REQUEST_TIMEOUT_MS", 15_000),
  /// EIP-712 domain for POST /v1/withdraw and POST /v1/transfer (identical apart
  /// from `name`). Withdrawals run against Robinhood Chain testnet, where
  /// deposits happen too. Arcus warns testnet addresses change on resets, so
  /// these stay configurable; the old ARCUS_ROOT_CHAIN_ID / ARCUS_BRIDGE_VAULT
  /// names are still read.
  arcusChainId: num("ARCUS_CHAIN_ID", num("ARCUS_ROOT_CHAIN_ID", 46630)),
  arcusBridgeVaultAddress: optional(
    "ARCUS_BRIDGE_VAULT_ADDRESS",
    optional("ARCUS_BRIDGE_VAULT", "0x9a6d3499149fea853efe775a3577701539054eaf"),
  ),
  /// How POST /v1/withdraw is authenticated. "wallet" = EIP-712 signature from
  /// the internal wallet (works with any key). "apikey" = Ed25519 over the
  /// WithdrawV1 payload -- needs keys carrying the `withdraw` permission, which
  /// Arcus grants only through its operator provisioning flow (keys from the
  /// public createApiKey are trade-only and get a 403).
  arcusWithdrawSigning: optional("ARCUS_WITHDRAW_SIGNING", "wallet") as "wallet" | "apikey",
  /// Subscriptions per shared stream connection. Arcus caps a connection at
  /// 100; the headroom absorbs a resubscribe overlapping the old one.
  arcusStreamSubsPerConnection: num("ARCUS_STREAM_SUBS_PER_CONNECTION", 90),
  /// Every awaited stream event (fill, deposit credit, withdrawal) also polls
  /// REST at this interval; whichever answers first wins.
  arcusFallbackPollMs: num("ARCUS_FALLBACK_POLL_MS", 15_000),
  /// Testnet USDG has an open mint, so buy-ins fund Arcus and redeem payouts
  /// top up from freshly minted USDG. Off on mainnet (float instead).
  usdgMintable: bool("USDG_MINTABLE", true),
  /// Arcus's PaxosDepositProxy on Robinhood Chain. The slot's internal wallet
  /// calls `initiateDeposit(owner, accountIndex, USDG, amount)` on it -- Arcus
  /// requires `owner` to be the signer, which is why users pay the internal
  /// wallet rather than Arcus. Testnet address changes on every Arcus reset.
  arcusDepositProxy: optional("ARCUS_DEPOSIT_PROXY"),

  // --- Orchestration timings -----------------------------------------------
  reservationTimeoutMs: num("RESERVATION_TIMEOUT_MS", 15 * 60_000),
  depositPollIntervalMs: num("DEPOSIT_POLL_INTERVAL_MS", 5_000),
  /// How long to wait for Arcus to credit an initiateDeposit (usually < 1 min),
  /// and for a refund withdrawal to arrive back on-chain.
  arcusCreditTimeoutMs: num("ARCUS_CREDIT_TIMEOUT_MS", 10 * 60_000),
  arcusWithdrawalTimeoutMs: num("ARCUS_WITHDRAWAL_TIMEOUT_MS", 60 * 60_000),
  /// Arcus applying a withdrawal (the WITHDRAWAL event), then the USDG landing
  /// on the internal wallet on-chain.
  withdrawalAppliedTimeoutMs: num("WITHDRAWAL_APPLIED_TIMEOUT_MS", 10 * 60_000),
  usdgArrivalTimeoutMs: num("USDG_ARRIVAL_TIMEOUT_MS", 20 * 60_000),
  fillTimeoutMs: num("FILL_TIMEOUT_MS", 60_000),
  reconcileIntervalMs: num("RECONCILE_INTERVAL_MS", 3 * 60_000),
  /// Absolute USD drift tolerated between ledger and Arcus equity before alert.
  reconcileDriftTolerance: optional("RECONCILE_DRIFT_TOLERANCE", "1"),
  /// How often the live indexer re-writes its checkpoint to the latest block
  /// seen. Not required for correctness (event handlers are idempotent), just
  /// bounds a restart's backfill window.
  indexerCheckpointIntervalMs: num("INDEXER_CHECKPOINT_INTERVAL_MS", 60_000),
  /// How often the reporting job checks every allocated position's price/funding
  /// against what's on-chain.
  reporterIntervalMs: num("REPORTER_INTERVAL_MS", 60_000),
  /// How often the market table re-syncs from Arcus: status, isOutsideRth and
  /// display prices. One Arcus call per tick.
  marketSyncIntervalMs: num("MARKET_SYNC_INTERVAL_MS", 60_000),
  /// How often the liquidation bot reads healthFactor() for every known
  /// (pool, borrower) pair. Faster than the reporter's own heartbeat would just
  /// waste RPC calls on unchanged prices -- see MAX_REPORT_AGE on LendingPool.
  liquidatorIntervalMs: num("LIQUIDATOR_INTERVAL_MS", 60_000),
  /// How often closes/settlements left unfinished (restart, Arcus still
  /// winding down a liquidation) are resumed. Runs with the reconciler.
  settlementIntervalMs: num("SETTLEMENT_INTERVAL_MS", 60_000),

  // --- Background workers --------------------------------------------------
  // Off by default so `npm run dev` gives a plain API server; flip on where the
  // orchestration is meant to actually run.
  enableIndexer: bool("ENABLE_INDEXER", false),
  enableReconciler: bool("ENABLE_RECONCILER", false),
  enableReporter: bool("ENABLE_REPORTER", false),
  enableLiquidator: bool("ENABLE_LIQUIDATOR", false),

  // --- Auth ----------------------------------------------------------------
  /// Backend calls carry a Privy access token; these verify it and look the
  /// user's linked wallet up server-side.
  privyAppId: optional("PRIVY_APP_ID"),
  privyAppSecret: optional("PRIVY_APP_SECRET"),
  /// Optional: the app's JWT verification key from the Privy dashboard. Unset,
  /// the SDK fetches it over JWKS instead.
  privyJwtVerificationKey: optional("PRIVY_JWT_VERIFICATION_KEY"),

  // --- Gas faucet ----------------------------------------------------------
  /// A brand-new embedded wallet holds zero native gas and cannot sign
  /// anything, so user creation drips it a little. Its own wallet -- none of
  /// the operator's or the liquidator's roles. Unset, no drip.
  faucetPrivateKey: optional("FAUCET_PRIVATE_KEY"),
  /// Human ETH amounts.
  faucetDripEth: optional("FAUCET_DRIP_ETH", "0.002"),
  faucetMinBalanceEth: optional("FAUCET_MIN_BALANCE_ETH", "0.001"),
} as const;

/// Fail loudly at boot for the values the orchestration cannot run without,
/// rather than at the first trade. Called from src/index.ts only when the
/// corresponding worker is enabled.
export function assertOrchestrationConfig(): void {
  const missing: string[] = [];
  if (!config.rpcUrl) missing.push("RPC_URL");
  if (!config.positionTokenFactoryAddress) missing.push("POSITION_TOKEN_FACTORY_ADDRESS");
  if (!config.operatorPrivateKey) missing.push("OPERATOR_PRIVATE_KEY");
  if (!config.lendingPoolFactoryAddress) missing.push("LENDING_POOL_FACTORY_ADDRESS");
  if (!config.usdgAddress) missing.push("USDG_ADDRESS");
  if (!config.arcusDepositProxy) missing.push("ARCUS_DEPOSIT_PROXY");
  if (!config.arcusApiBaseUrl) missing.push("ARCUS_API_BASE_URL");
  if (config.enableLiquidator && !config.liquidatorPrivateKey) missing.push("LIQUIDATOR_PRIVATE_KEY");
  if (missing.length > 0) {
    throw new Error(`Orchestration enabled but missing env vars: ${missing.join(", ")}`);
  }
  if (config.arcusSlippageBps > 1000) {
    throw new Error("ARCUS_SLIPPAGE_BPS must be <= 1000 (Arcus rejects >10% from mark)");
  }
}

export { required };
