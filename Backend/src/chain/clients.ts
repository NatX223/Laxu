import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  webSocket,
  type Address,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { config } from "../config/env";
import { USDG_DECIMALS } from "../lib/units";
import { erc20Abi, positionTokenFactoryAbi } from "./abi";
function chain() {
  return defineChain({
    id: config.chainId || 1,
    name: "laxu-chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
}

/// ws/wss gets a real `eth_subscribe` transport, which is what lets the
/// indexer's watchContractEvent calls push instead of poll; anything else
/// falls back to http, where watchContractEvent polls under the hood.
function readTransport(): Transport {
  return /^wss?:\/\//i.test(config.rpcUrl) ? webSocket(config.rpcUrl) : http(config.rpcUrl);
}

let publicClientInstance: PublicClient | undefined;

export function publicClient(): PublicClient {
  if (!publicClientInstance) {
    if (!config.rpcUrl) throw new Error("RPC_URL is not configured");
    publicClientInstance = createPublicClient({
      chain: chain(),
      transport: readTransport(),
    }) as PublicClient;
  }
  return publicClientInstance;
}

function normalisePrivateKey(key: string, label: string): `0x${string}` {
  const hex = key.startsWith("0x") ? key : `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${label} is not a 32-byte hex private key`);
  }
  return hex as `0x${string}`;
}

/**
 * Signers, kept apart by role:
 *
 *   operator   -- every Laxu contract write: createPosition, createPool,
 *                 applyReport, fulfil*, close. The Factory passes its
 *                 `deployer` through as each token's `arcusOperator`, so those
 *                 are one address and need one key.
 *   liquidator -- LendingPool.liquidate(); PERMISSIONLESS on-chain, but kept
 *                 as its own wallet anyway so it carries none of the operator's
 *                 privileges -- it only ever needs a USDG balance and standing
 *                 pool approvals.
 *
 * The internal Arcus wallets (operator_wallets) are a separate family again:
 * see {internalWallet}. They never touch Laxu's contracts.
 */
function walletFor(key: string, label: string): WalletClient {
  return createWalletClient({
    account: privateKeyToAccount(normalisePrivateKey(key, label)),
    chain: chain(),
    transport: http(config.rpcUrl),
  });
}

let operatorInstance: WalletClient | undefined;
let liquidatorInstance: WalletClient | undefined;

export function operatorWallet(): WalletClient {
  if (!operatorInstance) {
    operatorInstance = walletFor(config.operatorPrivateKey, "OPERATOR_PRIVATE_KEY");
  }
  return operatorInstance;
}

export function liquidatorWallet(): WalletClient {
  if (!liquidatorInstance) {
    liquidatorInstance = walletFor(config.liquidatorPrivateKey, "LIQUIDATOR_PRIVATE_KEY");
  }
  return liquidatorInstance;
}

/// An internal Arcus wallet's signer, from its EVM key. These wallets receive
/// creators' USDG, deposit it into their own subaccounts, and send refunds, so
/// the backend holds their keys at runtime. Each needs a little ETH for gas.
const internalWallets = new Map<string, WalletClient>();

export function internalWallet(privateKey: string, label: string): WalletClient {
  const cached = internalWallets.get(privateKey);
  if (cached) return cached;
  const wallet = walletFor(privateKey, label);
  internalWallets.set(privateKey, wallet);
  return wallet;
}

/**
 * One transaction at a time per sending address. Up to ten slots share one
 * internal wallet, so two users' deposits (or a deposit and a refund) would
 * otherwise race for the same nonce. The operator key goes through the same
 * queue, since createPosition/createPool/fulfil* can run concurrently too.
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

/// New-user gas drip only. Kept apart from the roles above for the same
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

export function usdgAddress(): Address {
  if (!config.usdgAddress) throw new Error("USDG_ADDRESS is not configured");
  return config.usdgAddress as Address;
}

export function depositProxyAddress(): Address {
  if (!config.arcusDepositProxy) throw new Error("ARCUS_DEPOSIT_PROXY is not configured");
  return config.arcusDepositProxy as Address;
}

export function lendingPoolFactoryAddress(): Address {
  if (!config.lendingPoolFactoryAddress) {
    throw new Error("LENDING_POOL_FACTORY_ADDRESS is not configured");
  }
  return config.lendingPoolFactoryAddress as Address;
}

// ---------------------------------------------------------------------------
// USDG decimals. Read once from the chain rather than assumed: every conversion
// between Arcus's human dollar strings and on-chain base units depends on it.
// ---------------------------------------------------------------------------

let usdgDecimalsCache: number | undefined;

export async function usdgDecimals(): Promise<number> {
  if (usdgDecimalsCache !== undefined) return usdgDecimalsCache;

  let address = config.usdgAddress as Address | undefined;
  if (!address) {
    address = (await publicClient().readContract({
      address: factoryAddress(),
      abi: positionTokenFactoryAbi,
      functionName: "usdg",
    })) as Address;
  }

  const decimals = await publicClient().readContract({
    address,
    abi: erc20Abi,
    functionName: "decimals",
  });

  // lib/units.ts fixes USDG, shares and size at 6 decimals -- the scale that
  // makes PositionToken's `size * (mark - entry) / 1e18` land in USDG. A token
  // with any other decimals would make every amount silently wrong, so refuse it.
  if (Number(decimals) !== USDG_DECIMALS) {
    throw new Error(`USDG at ${address} has ${decimals} decimals; lib/units.ts assumes ${USDG_DECIMALS}`);
  }
  usdgDecimalsCache = Number(decimals);
  return usdgDecimalsCache;
}

/// PositionToken.PRICE_SCALE.
export const PRICE_SCALE = 10n ** 18n;

export function resetChainClients(): void {
  publicClientInstance = undefined;
  operatorInstance = undefined;
  internalWallets.clear();
  liquidatorInstance = undefined;
  faucetInstance = undefined;
  usdgDecimalsCache = undefined;
}
