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
  usdgAddress: optional("USDG_ADDRESS"),
  /// Gated to createPosition() on the Factory.
  deployerPrivateKey: optional("DEPLOYER_PRIVATE_KEY"),
  /// Fulfillment + close calls on PositionToken. Distinct key from the deployer
  /// by policy; note the Factory currently passes `deployer` through as the
  /// token's `arcusOperator`, so on-chain they must resolve to the same address
  /// until that wiring is split.
  arcusOperatorPrivateKey: optional("ARCUS_OPERATOR_PRIVATE_KEY"),
  /// Creator fee applied by the Factory at mint. Basis points, max 2000.
  creatorFeeBps: num("CREATOR_FEE_BPS", 0),

  // --- Arcus ---------------------------------------------------------------
  arcusApiBaseUrl: optional("ARCUS_API_BASE_URL", "https://api.testnet.arcus.xyz"),
  arcusWsUrl: optional("ARCUS_WS_URL", "wss://api.testnet.arcus.xyz/v1/ws"),
  /// Slippage bound on the protective MARKET price, in basis points. Arcus
  /// rejects anything beyond 10% of mark, so this must stay under 1000.
  arcusSlippageBps: num("ARCUS_SLIPPAGE_BPS", 900),
  /// goodTilTime is mandatory on every order, including IOC, and must sit at
  /// least one month ahead. Two months of headroom absorbs clock skew.
  arcusGoodTilDays: num("ARCUS_GOOD_TIL_DAYS", 60),
  arcusRequestTimeoutMs: num("ARCUS_REQUEST_TIMEOUT_MS", 15_000),
  /// EIP-712 domain for POST /v1/transfer, used to sweep a closed position's
  /// leftover collateral back to index 0. Per-environment values; the domain is
  /// identical to the withdraw domain apart from its `name`.
  arcusRootChainId: num("ARCUS_ROOT_CHAIN_ID", 0),
  arcusBridgeVault: optional("ARCUS_BRIDGE_VAULT"),

  // --- Orchestration timings -----------------------------------------------
  reservationTimeoutMs: num("RESERVATION_TIMEOUT_MS", 15 * 60_000),
  depositPollIntervalMs: num("DEPOSIT_POLL_INTERVAL_MS", 5_000),
  fillTimeoutMs: num("FILL_TIMEOUT_MS", 60_000),
  reconcileIntervalMs: num("RECONCILE_INTERVAL_MS", 3 * 60_000),
  /// Absolute USD drift tolerated between ledger and Arcus equity before alert.
  reconcileDriftTolerance: optional("RECONCILE_DRIFT_TOLERANCE", "1"),
  indexerPollIntervalMs: num("INDEXER_POLL_INTERVAL_MS", 5_000),
  indexerBlockBatchSize: num("INDEXER_BLOCK_BATCH_SIZE", 2_000),
  indexerConfirmations: num("INDEXER_CONFIRMATIONS", 1),
  /// How often the reporting job checks every allocated position's price/funding
  /// against what's on-chain.
  reporterIntervalMs: num("REPORTER_INTERVAL_MS", 60_000),

  // --- Background workers --------------------------------------------------
  // Off by default so `npm run dev` gives a plain API server; flip on where the
  // orchestration is meant to actually run.
  enableIndexer: bool("ENABLE_INDEXER", false),
  enableReconciler: bool("ENABLE_RECONCILER", false),
  enableReporter: bool("ENABLE_REPORTER", false),

  // --- Auth ----------------------------------------------------------------
  siweDomain: optional("SIWE_DOMAIN", "localhost:3000"),
  siweUri: optional("SIWE_URI", "http://localhost:3000"),
  sessionSecret: optional("SESSION_SECRET", ""),
  sessionTtlMs: num("SESSION_TTL_MS", 24 * 60 * 60_000),
} as const;

/// Fail loudly at boot for the values the orchestration cannot run without,
/// rather than at the first trade. Called from src/index.ts only when the
/// corresponding worker is enabled.
export function assertOrchestrationConfig(): void {
  const missing: string[] = [];
  if (!config.rpcUrl) missing.push("RPC_URL");
  if (!config.positionTokenFactoryAddress) missing.push("POSITION_TOKEN_FACTORY_ADDRESS");
  if (!config.deployerPrivateKey) missing.push("DEPLOYER_PRIVATE_KEY");
  if (!config.arcusOperatorPrivateKey) missing.push("ARCUS_OPERATOR_PRIVATE_KEY");
  if (!config.arcusApiBaseUrl) missing.push("ARCUS_API_BASE_URL");
  if (missing.length > 0) {
    throw new Error(`Orchestration enabled but missing env vars: ${missing.join(", ")}`);
  }
  if (config.arcusSlippageBps > 1000) {
    throw new Error("ARCUS_SLIPPAGE_BPS must be <= 1000 (Arcus rejects >10% from mark)");
  }
  if (config.creatorFeeBps > 2000) {
    throw new Error("CREATOR_FEE_BPS must be <= 2000 (PositionToken.MAX_CREATOR_FEE_BPS)");
  }
}

export { required };
