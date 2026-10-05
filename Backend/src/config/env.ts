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

/// The first of `names` that is set (and non-empty), else `fallback`. For a
/// renamed variable whose old name is still read.
function firstOf(names: string[], fallback = ""): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return fallback;
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
  port: num("PORT", 4000),
  nodeEnv: optional("NODE_ENV", "development"),
  logLevel: optional("LOG_LEVEL", "info"),

  // --- Chain (Monad testnet) -----------------------------------------------
  /// HTTPS only: every read and write goes over plain JSON-RPC.
  rpcUrl: optional("RPC_URL", "https://testnet-rpc.monad.xyz"),
  chainId: num("CHAIN_ID", 10143),
  positionTokenFactoryAddress: optional("POSITION_TOKEN_FACTORY_ADDRESS"),
  /// Backfill start point when the indexer checkpoint doesn't exist yet.
  /// Kept as a string and parsed with BigInt() at the call site -- a block
  /// number can exceed Number's safe integer range on some chains.
  positionTokenFactoryDeployBlock: optional("POSITION_TOKEN_FACTORY_DEPLOY_BLOCK", "0"),
  /// Perpl's collateral token (AUSD on testnet) -- the asset every Laxu
  /// contract is denominated in. USDG_ADDRESS is a deprecated alias.
  assetAddress: firstOf(["ASSET_ADDRESS", "USDG_ADDRESS"]),
  /// PerplReader: what PositionToken prices itself with.
  perplReaderAddress: optional("PERPL_READER_ADDRESS"),
  /// The one backend key for every Laxu contract write: createPosition,
  /// createPool, applyFunding, fulfil*, close. PositionTokenFactory passes its
  /// `deployer` through as each token's `operator`, so the two roles are
  /// always the same address.
  operatorPrivateKey: optional("OPERATOR_PRIVATE_KEY"),

  lendingPoolFactoryAddress: optional("LENDING_POOL_FACTORY_ADDRESS"),
  /// Backfill start point for LendingPoolFactory.PoolCreated + per-pool
  /// CollateralDeposited/Borrowed, same reasoning as the position token
  /// factory's own deploy-block env var.
  lendingPoolFactoryDeployBlock: optional("LENDING_POOL_FACTORY_DEPLOY_BLOCK", "0"),
  /// liquidate() is permissionless -- this wallet holds none of the operator's
  /// roles, only an asset balance and pool approvals.
  liquidatorPrivateKey: optional("LIQUIDATOR_PRIVATE_KEY"),

  // --- Perpl ---------------------------------------------------------------
  perplApiUrl: optional("PERPL_API_URL", "https://testnet.perpl.xyz/api"),
  perplWsUrl: optional("PERPL_WS_URL", "wss://testnet.perpl.xyz"),
  perplChainId: num("PERPL_CHAIN_ID", 10143),
  perplExchangeAddress: optional("PERPL_EXCHANGE", "0x1964C32f0bE608E7D29302AFF5E61268E72080cc"),
  /// Only for programmatic API-key enrollment (scripts/provisionSlots.ts):
  /// Perpl must have whitelisted this Origin.
  perplOrigin: optional("PERPL_ORIGIN"),
  /// Market-order slippage bound (`ms`), clamped to each market's
  /// order_max_market_slippage_bps.
  perplSlippageBps: num("PERPL_SLIPPAGE_BPS", 100),
  /// How long to wait for an order's outcome on the trading WebSocket before
  /// treating it as unknown and looking it up instead.
  perplOrderTimeoutMs: num("PERPL_ORDER_TIMEOUT_MS", 30_000),
  perplRequestTimeoutMs: num("PERPL_REQUEST_TIMEOUT_MS", 15_000),
  /// Asset base units kept in every slot account. Empty = the exchange's
  /// minimum account open amount, converted to asset units.
  perplSlotReserve: optional("PERPL_SLOT_RESERVE"),
  /// A heartbeat `sn` gap forces a trading-socket reconnect (fresh snapshots).
  /// `false` only logs it -- a testing safety valve against a reconnect loop if
  /// the gap rule itself turns out to be wrong.
  perplHeartbeatGapReconnect: bool("PERPL_HEARTBEAT_GAP_RECONNECT", true),
  /// When set, every trading-WS frame (in and out) and every REST call is
  /// appended, redacted, as JSONL under this directory. Testing/fixtures only.
  perplRecordDir: optional("PERPL_RECORD_DIR"),

  // --- Float ---------------------------------------------------------------
  /// Fronts buy-in funding and redeem payouts (replaces minting). Defaults to
  /// the operator key.
  floatPrivateKey: firstOf(["FLOAT_PRIVATE_KEY", "OPERATOR_PRIVATE_KEY"]),
  /// True only for a test token with an open `mint(to, amount)`; the float is
  /// then topped up by minting instead of a transfer from FLOAT_PRIVATE_KEY.
  assetMintable: bool("ASSET_MINTABLE", false),

  // --- Funding reporter ----------------------------------------------------
  /// applyFunding at least this often per position, even with nothing to
  /// report. Must stay well under PositionToken.FUNDING_MAX_AGE (2h), past
  /// which isPriceFresh() turns false and borrowing pauses.
  fundingHeartbeatSeconds: num("FUNDING_HEARTBEAT_SECONDS", 1800),
  /// Push when the computed funding moved by at least
  /// max(FUNDING_PUSH_MIN, capital x FUNDING_PUSH_BPS / 1e4). Asset base units.
  fundingPushMin: optional("FUNDING_PUSH_MIN", "100000"),
  fundingPushBps: num("FUNDING_PUSH_BPS", 10),

  // --- Orchestration timings -----------------------------------------------
  reservationTimeoutMs: num("RESERVATION_TIMEOUT_MS", 15 * 60_000),
  depositPollIntervalMs: num("DEPOSIT_POLL_INTERVAL_MS", 5_000),
  reconcileIntervalMs: num("RECONCILE_INTERVAL_MS", 3 * 60_000),
  /// Absolute drift (asset, human decimal) tolerated between the ledger and
  /// the venue before an alert.
  reconcileDriftTolerance: optional("RECONCILE_DRIFT_TOLERANCE", "1"),
  /// How often the live indexer re-writes its checkpoint to the latest block
  /// seen. Not required for correctness (event handlers are idempotent), just
  /// bounds a restart's backfill window.
  indexerCheckpointIntervalMs: num("INDEXER_CHECKPOINT_INTERVAL_MS", 60_000),
  /// How often the funding reporter checks every allocated position.
  reporterIntervalMs: num("REPORTER_INTERVAL_MS", 60_000),
  /// How often the market table re-syncs from Perpl: status and display
  /// prices. One public call per tick.
  marketSyncIntervalMs: num("MARKET_SYNC_INTERVAL_MS", 60_000),
  /// How often the liquidation bot reads healthFactor() for every known
  /// (pool, borrower) pair.
  liquidatorIntervalMs: num("LIQUIDATOR_INTERVAL_MS", 60_000),
  /// How often closes/settlements left unfinished (restart, a withdrawal
  /// rate limit) are resumed. Runs with the reconciler.
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

  /// Hops of reverse proxy in front of the API, for `req.ip` (the faucet's
  /// per-IP limit). Behind one proxy (Render, Railway, Fly), 1; unproxied, 0 --
  /// otherwise a client could pick its own IP through X-Forwarded-For.
  trustProxy: num("TRUST_PROXY", 1),

  // --- Admin ---------------------------------------------------------------
  /// Shared secret for /admin/*, sent as `x-admin-token`. Unset, /admin is off.
  adminToken: optional("ADMIN_TOKEN"),

  // --- Test funds faucet (testnet only) ------------------------------------
  /// A brand-new embedded wallet holds zero native gas and cannot sign
  /// anything, so "Get test funds" sends the asset and tops its MON up, all
  /// paid by the faucet wallet. Its own key -- none of the operator's,
  /// liquidator's or slot wallets' roles. See assertFaucetConfig.
  faucetEnabled: bool("FAUCET_ENABLED", false),
  faucetPrivateKey: optional("FAUCET_PRIVATE_KEY"),
  /// `transfer`: from the pre-funded faucet wallet (the default unless the
  /// asset is mintable). `direct`: asset.mint(user, amount).
  /// `mint_then_transfer`: asset.mint(amount) to the faucet, then transfer.
  faucetAssetMode: firstOf(
    ["FAUCET_ASSET_MODE", "FAUCET_USDG_MODE"],
    bool("ASSET_MINTABLE", false) ? "direct" : "transfer",
  ) as "transfer" | "direct" | "mint_then_transfer",
  /// Base units (6 decimals); 1_000_000_000 = 1,000. bigint-parsed in
  /// assertFaucetConfig.
  faucetAssetAmount: firstOf(["FAUCET_ASSET_AMOUNT", "FAUCET_USDG_AMOUNT"], "1000000000"),
  /// Tops the user's native balance up TO this (wei), not "sends this much".
  faucetNativeTargetWei: firstOf(["FAUCET_NATIVE_TARGET_WEI", "FAUCET_ETH_TARGET_WEI"], "500000000000000000"),
  faucetCooldownHours: num("FAUCET_COOLDOWN_HOURS", 24),
  /// Below this (wei) the faucet stops sending gas but keeps sending the asset.
  faucetNativeMinReserveWei: firstOf(
    ["FAUCET_NATIVE_MIN_RESERVE_WEI", "FAUCET_MIN_RESERVE_WEI"],
    "2000000000000000000",
  ),
} as const;

const WEI_OR_UNITS = /^\d+$/;
const FAUCET_MODES = ["transfer", "direct", "mint_then_transfer"] as const;

/// Refuses to boot with FAUCET_ENABLED=true and anything the claim path would
/// only trip over at a tester's first click. Called from src/index.ts.
export function assertFaucetConfig(): void {
  if (!config.faucetEnabled) return;
  const problems: string[] = [];
  if (!config.faucetPrivateKey) problems.push("FAUCET_PRIVATE_KEY is required");
  if (!config.rpcUrl) problems.push("RPC_URL is required");
  if (!config.assetAddress) problems.push("ASSET_ADDRESS is required");
  if (!FAUCET_MODES.includes(config.faucetAssetMode)) {
    problems.push(`FAUCET_ASSET_MODE must be one of ${FAUCET_MODES.join(", ")}, got ${config.faucetAssetMode}`);
  }
  if (config.faucetAssetMode !== "transfer" && !config.assetMintable) {
    problems.push(`FAUCET_ASSET_MODE=${config.faucetAssetMode} needs a mintable asset (ASSET_MINTABLE=true)`);
  }
  for (const [name, value] of [
    ["FAUCET_ASSET_AMOUNT", config.faucetAssetAmount],
    ["FAUCET_NATIVE_TARGET_WEI", config.faucetNativeTargetWei],
    ["FAUCET_NATIVE_MIN_RESERVE_WEI", config.faucetNativeMinReserveWei],
  ] as const) {
    if (!WEI_OR_UNITS.test(value)) problems.push(`${name} must be a whole number of base units, got ${value}`);
  }
  if (WEI_OR_UNITS.test(config.faucetAssetAmount) && BigInt(config.faucetAssetAmount) === 0n) {
    problems.push("FAUCET_ASSET_AMOUNT must be above 0");
  }
  if (!(config.faucetCooldownHours > 0)) problems.push("FAUCET_COOLDOWN_HOURS must be above 0");
  if (problems.length > 0) {
    throw new Error(`FAUCET_ENABLED=true but: ${problems.join("; ")}`);
  }
}

/// Fail loudly at boot for the values the orchestration cannot run without,
/// rather than at the first trade. Called from src/index.ts only when the
/// corresponding worker is enabled.
export function assertOrchestrationConfig(): void {
  const missing: string[] = [];
  if (!config.rpcUrl) missing.push("RPC_URL");
  if (!config.positionTokenFactoryAddress) missing.push("POSITION_TOKEN_FACTORY_ADDRESS");
  if (!config.operatorPrivateKey) missing.push("OPERATOR_PRIVATE_KEY");
  if (!config.lendingPoolFactoryAddress) missing.push("LENDING_POOL_FACTORY_ADDRESS");
  if (!config.assetAddress) missing.push("ASSET_ADDRESS");
  if (!config.perplReaderAddress) missing.push("PERPL_READER_ADDRESS");
  if (!config.perplExchangeAddress) missing.push("PERPL_EXCHANGE");
  if (!config.perplApiUrl) missing.push("PERPL_API_URL");
  if (!config.perplWsUrl) missing.push("PERPL_WS_URL");
  if (!config.floatPrivateKey) missing.push("FLOAT_PRIVATE_KEY");
  if (config.enableLiquidator && !config.liquidatorPrivateKey) missing.push("LIQUIDATOR_PRIVATE_KEY");
  if (missing.length > 0) {
    throw new Error(`Orchestration enabled but missing env vars: ${missing.join(", ")}`);
  }
  if (!/^https:\/\//i.test(config.rpcUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(config.rpcUrl)) {
    throw new Error("RPC_URL must be an https:// endpoint");
  }
  if (config.perplChainId !== config.chainId) {
    throw new Error(`PERPL_CHAIN_ID (${config.perplChainId}) must equal CHAIN_ID (${config.chainId})`);
  }
  if (!(config.perplSlippageBps > 0)) throw new Error("PERPL_SLIPPAGE_BPS must be above 0");
  if (!WEI_OR_UNITS.test(config.fundingPushMin)) {
    throw new Error(`FUNDING_PUSH_MIN must be a whole number of base units, got ${config.fundingPushMin}`);
  }
  if (config.perplSlotReserve && !WEI_OR_UNITS.test(config.perplSlotReserve)) {
    throw new Error(`PERPL_SLOT_RESERVE must be a whole number of base units, got ${config.perplSlotReserve}`);
  }
  // PositionToken.FUNDING_MAX_AGE is 2h; a heartbeat near it lets borrowing
  // pause on a single missed tick.
  if (!(config.fundingHeartbeatSeconds > 0) || config.fundingHeartbeatSeconds > 3600) {
    throw new Error("FUNDING_HEARTBEAT_SECONDS must be between 1 and 3600 (the contract allows 7200)");
  }
}

export { required };
