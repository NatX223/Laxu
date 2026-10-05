import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { config } from "../config/env";
import { ASSET_DECIMALS_DEFAULT } from "../lib/units";
import { erc20Abi, positionTokenFactoryAbi } from "./abi";

export function chain() {
  return defineChain({
    id: config.chainId,
    name: config.chainId === 10143 ? "Monad Testnet" : `chain-${config.chainId}`,
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
}

let publicClientInstance: PublicClient | undefined;

// ---------------------------------------------------------------------------
// One throttled transport for every client in the process. Monad's public RPC
// answers "requests limited to 25/sec" (15/sec for some methods) as a JSON-RPC
// error, which viem does not retry: requests are spaced to RPC_MAX_RPS and a
// rate-limit answer is retried with backoff.
// ---------------------------------------------------------------------------

const RPC_MAX_RPS = Math.max(1, Number(process.env.RPC_MAX_RPS ?? 12));
const RATE_LIMIT_RETRIES = 6;
let nextSlotAt = 0;

/// Resolves when this request may go out: at most RPC_MAX_RPS per second.
function rpcSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + 1000 / RPC_MAX_RPS;
  return at > now ? new Promise((resolve) => setTimeout(resolve, at - now)) : Promise.resolve();
}

function isRateLimited(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${(error as { details?: string }).details ?? ""}` : String(error);
  return /limited to \d+\/sec|rate limit|too many requests|429/i.test(text);
}

function rpcTransport(): Transport {
  const inner = http(config.rpcUrl, { retryCount: 2 });
  return ((params: Parameters<Transport>[0]) => {
    const transport = inner(params);
    return {
      ...transport,
      request: (async (args: unknown) => {
        for (let attempt = 0; ; attempt += 1) {
          await rpcSlot();
          try {
            return await transport.request(args as never);
          } catch (error) {
            if (attempt >= RATE_LIMIT_RETRIES || !isRateLimited(error)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
          }
        }
      }) as typeof transport.request,
    };
  }) as Transport;
}

/// Plain HTTPS JSON-RPC for every read. The indexer's watchContractEvent then
/// polls under the hood, which is what Monad's public RPC supports reliably.
export function publicClient(): PublicClient {
  if (!publicClientInstance) {
    if (!config.rpcUrl) throw new Error("RPC_URL is not configured");
    const base = createPublicClient({
      chain: chain(),
      transport: rpcTransport(),
    });
    // Monad's public RPC refuses eth_getLogs over more than 100 blocks. Every
    // getLogs -- the indexer's backfill, viem's own event polling (it calls
    // through the client's action), the services -- goes through this, which
    // splits a wider range into windows.
    const plainGetLogs = base.getLogs.bind(base) as (args: GetLogsArgs) => Promise<unknown[]>;
    publicClientInstance = base.extend(() => ({
      getLogs: ((args: GetLogsArgs) => chunkedGetLogs(base, plainGetLogs, args)) as never,
    })) as unknown as PublicClient;
  }
  return publicClientInstance;
}

type GetLogsArgs = { fromBlock?: bigint | string; toBlock?: bigint | string } & Record<string, unknown>;

const LOGS_MAX_RANGE = BigInt(Math.max(1, Number(process.env.RPC_LOGS_MAX_RANGE ?? 100)));
/// Windows in flight across ALL getLogs calls: a backfill fans out ~18 event
/// queries at once, and the public RPC rate-limits.
const LOGS_CONCURRENCY = 8;
let logsInFlight = 0;
const logsQueue: Array<() => void> = [];

async function withLogsSlot<T>(task: () => Promise<T>): Promise<T> {
  if (logsInFlight >= LOGS_CONCURRENCY) await new Promise<void>((resolve) => logsQueue.push(resolve));
  logsInFlight += 1;
  try {
    return await task();
  } finally {
    logsInFlight -= 1;
    logsQueue.shift()?.();
  }
}

/// getLogs over [fromBlock, toBlock] in windows of at most LOGS_MAX_RANGE
/// blocks, a few at a time, results in block order. Tags are resolved first;
/// a request without a numeric fromBlock (e.g. a filter-only call) is passed through.
async function chunkedGetLogs(
  client: { getBlockNumber: () => Promise<bigint> },
  getLogs: (args: GetLogsArgs) => Promise<unknown[]>,
  args: GetLogsArgs,
): Promise<unknown[]> {
  if (typeof args.fromBlock !== "bigint") return withLogsSlot(() => getLogs(args));
  const from = args.fromBlock;
  const to = typeof args.toBlock === "bigint" ? args.toBlock : await client.getBlockNumber();
  if (to < from || to - from + 1n <= LOGS_MAX_RANGE) return withLogsSlot(() => getLogs({ ...args, toBlock: to }));

  const windows: Array<[bigint, bigint]> = [];
  for (let start = from; start <= to; start += LOGS_MAX_RANGE) {
    const end = start + LOGS_MAX_RANGE - 1n;
    windows.push([start, end < to ? end : to]);
  }
  const results = await Promise.all(
    windows.map(([start, end]) => withLogsSlot(() => getLogs({ ...args, fromBlock: start, toBlock: end }))),
  );
  return results.flat();
}

function normalisePrivateKey(key: string, label: string): `0x${string}` {
  const hex = key.startsWith("0x") ? key : `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${label} is not a 32-byte hex private key`);
  }
  return hex as `0x${string}`;
}

/// The address a private key controls.
export function addressOfKey(key: string, label = "private key"): Address {
  return privateKeyToAccount(normalisePrivateKey(key, label)).address;
}

/**
 * Signers, kept apart by role:
 *
 *   operator   -- every Laxu contract write: createPosition, createPool,
 *                 applyFunding, fulfil*, close. The Factory passes its
 *                 `deployer` through as each token's `operator`, so those are
 *                 one address and need one key.
 *   float      -- holds the asset that fronts buy-in funding and redeem
 *                 payouts. Defaults to the operator key.
 *   liquidator -- LendingPool.liquidate(); PERMISSIONLESS on-chain, but kept
 *                 as its own wallet anyway so it carries none of the operator's
 *                 privileges -- it only ever needs an asset balance and
 *                 standing pool approvals.
 *
 * The slot wallets (operator_wallets) are a separate family again: see
 * {slotWalletClient}. Each owns one Perpl account and never touches Laxu's
 * contracts.
 */
function walletFor(key: string, label: string): WalletClient {
  return createWalletClient({
    account: privateKeyToAccount(normalisePrivateKey(key, label)),
    chain: chain(),
    transport: rpcTransport(),
  });
}

let operatorInstance: WalletClient | undefined;
let floatInstance: WalletClient | undefined;
let liquidatorInstance: WalletClient | undefined;

export function operatorWallet(): WalletClient {
  if (!operatorInstance) {
    operatorInstance = walletFor(config.operatorPrivateKey, "OPERATOR_PRIVATE_KEY");
  }
  return operatorInstance;
}

export function floatWallet(): WalletClient {
  if (!floatInstance) {
    floatInstance = walletFor(config.floatPrivateKey, "FLOAT_PRIVATE_KEY");
  }
  return floatInstance;
}

export function floatAddress(): Address {
  const account = floatWallet().account;
  if (!account) throw new Error("float wallet has no account");
  return account.address;
}

export function liquidatorWallet(): WalletClient {
  if (!liquidatorInstance) {
    liquidatorInstance = walletFor(config.liquidatorPrivateKey, "LIQUIDATOR_PRIVATE_KEY");
  }
  return liquidatorInstance;
}

/// A slot wallet's signer, from its EVM key. These wallets receive creators'
/// asset, fund their own Perpl account, withdraw from it and send refunds, so
/// the backend holds their keys at runtime. Each needs a little MON for gas.
const slotWallets = new Map<string, WalletClient>();

export function slotWalletClient(privateKey: string, label: string): WalletClient {
  const cached = slotWallets.get(privateKey);
  if (cached) return cached;
  const wallet = walletFor(privateKey, label);
  slotWallets.set(privateKey, wallet);
  return wallet;
}

/**
 * One transaction at a time per sending address, so two flows sending from the
 * same wallet (a refund and a sweep, or concurrent createPosition / fulfil* on
 * the operator key) never race for a nonce.
 *
 * In-process only -- correct as long as one backend process sends for a given
 * wallet, which is how this service is deployed.
 */
const walletQueues = new Map<string, Promise<unknown>>();

export function withWalletLock<T>(address: string, task: () => Promise<T>): Promise<T> {
  const key = address.toLowerCase();
  const previous = walletQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  walletQueues.set(key, tail);
  void tail.then(() => {
    if (walletQueues.get(key) === tail) walletQueues.delete(key);
  });
  return run;
}

let faucetInstance: WalletClient | undefined;

/// The test funds faucet only (services/faucet.ts). Kept apart from the roles above for the same
/// reason they are kept apart from each other.
export function faucetWallet(): WalletClient {
  if (!faucetInstance) {
    faucetInstance = walletFor(config.faucetPrivateKey, "FAUCET_PRIVATE_KEY");
  }
  return faucetInstance;
}

export function factoryAddress(): Address {
  if (!config.positionTokenFactoryAddress) {
    throw new Error("POSITION_TOKEN_FACTORY_ADDRESS is not configured");
  }
  return config.positionTokenFactoryAddress as Address;
}

/// Perpl's collateral token -- every Laxu contract's asset.
export function assetAddress(): Address {
  if (!config.assetAddress) throw new Error("ASSET_ADDRESS is not configured");
  return config.assetAddress as Address;
}

/// @deprecated Use {assetAddress}.
export const usdgAddress = assetAddress;

export function readerAddress(): Address {
  if (!config.perplReaderAddress) throw new Error("PERPL_READER_ADDRESS is not configured");
  return config.perplReaderAddress as Address;
}

export function lendingPoolFactoryAddress(): Address {
  if (!config.lendingPoolFactoryAddress) {
    throw new Error("LENDING_POOL_FACTORY_ADDRESS is not configured");
  }
  return config.lendingPoolFactoryAddress as Address;
}

// ---------------------------------------------------------------------------
// Asset decimals. Read once from the chain rather than assumed: every
// conversion between human strings and on-chain base units depends on it.
// ---------------------------------------------------------------------------

let assetDecimalsCache: number | undefined;

export async function assetDecimals(): Promise<number> {
  if (assetDecimalsCache !== undefined) return assetDecimalsCache;

  let address = config.assetAddress as Address | undefined;
  if (!address) {
    address = (await publicClient().readContract({
      address: factoryAddress(),
      abi: positionTokenFactoryAbi,
      functionName: "asset",
    })) as Address;
  }

  const decimals = await publicClient().readContract({
    address,
    abi: erc20Abi,
    functionName: "decimals",
  });

  // The asset is fixed by the deployed contracts (AUSD). lib/units.ts's
  // toAsset6/fromAsset6 and every share amount use ASSET_DECIMALS_DEFAULT, so
  // this check is what makes that constant equal to assetDecimals(). It is a
  // real constraint, not a convenience: PositionToken.totalAssets =
  // capital + size * (mark - entry) / 1e18 only lands in the asset's units when
  // size (10^6, Laxu's size6) shares the asset's scale.
  if (Number(decimals) !== ASSET_DECIMALS_DEFAULT) {
    throw new Error(`Asset at ${address} has ${decimals} decimals; lib/units.ts assumes ${ASSET_DECIMALS_DEFAULT}`);
  }
  assetDecimalsCache = Number(decimals);
  return assetDecimalsCache;
}

/// @deprecated Use {assetDecimals}.
export const usdgDecimals = assetDecimals;

/// PositionToken.PRICE_SCALE.
export const PRICE_SCALE = 10n ** 18n;

export function resetChainClients(): void {
  publicClientInstance = undefined;
  operatorInstance = undefined;
  floatInstance = undefined;
  slotWallets.clear();
  liquidatorInstance = undefined;
  faucetInstance = undefined;
  assetDecimalsCache = undefined;
}
