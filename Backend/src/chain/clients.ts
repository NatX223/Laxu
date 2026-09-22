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
import { erc20Abi, positionTokenFactoryAbi } from "./abi";
import { createLogger } from "../lib/logger";

const log = createLogger("chain");

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
 * Two signers, kept apart by role:
 *
 *   deployer      -- gated to PositionTokenFactory.createPosition()
 *   arcusOperator -- fulfillDepositRequest / fulfillRedeemRequest / close
 *
 * Note the Factory passes its own `deployer` through as the minted token's
 * `arcusOperator`, so on-chain these two roles currently resolve to one address.
 * Keeping the keys separate here means the split costs a config change, not a
 * refactor, once the Factory takes an explicit operator argument.
 */
function walletFor(key: string, label: string): WalletClient {
  return createWalletClient({
    account: privateKeyToAccount(normalisePrivateKey(key, label)),
    chain: chain(),
    transport: http(config.rpcUrl),
  });
}

let deployerInstance: WalletClient | undefined;
let operatorInstance: WalletClient | undefined;

export function deployerWallet(): WalletClient {
  if (!deployerInstance) {
    deployerInstance = walletFor(config.deployerPrivateKey, "DEPLOYER_PRIVATE_KEY");
  }
  return deployerInstance;
}

export function arcusOperatorWallet(): WalletClient {
  if (!operatorInstance) {
    operatorInstance = walletFor(config.arcusOperatorPrivateKey, "ARCUS_OPERATOR_PRIVATE_KEY");
  }
  return operatorInstance;
}

export function factoryAddress(): Address {
  if (!config.positionTokenFactoryAddress) {
    throw new Error("POSITION_TOKEN_FACTORY_ADDRESS is not configured");
  }
  return config.positionTokenFactoryAddress as Address;
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

  usdgDecimalsCache = Number(decimals);

  // PositionToken computes pnl as `size * (mark - entry) / 1e18` in asset units,
  // which only lines up when the asset carries 18 decimals alongside the 1e18
  // PRICE_SCALE. A different asset decimal is not fatal here, but every value
  // this service writes on-chain would need rescaling first.
  if (usdgDecimalsCache !== 18) {
    log.warn("USDG decimals are not 18", {
      decimals: usdgDecimalsCache,
      note: "PositionToken value math assumes 18-decimal assets against PRICE_SCALE 1e18",
    });
  }

  return usdgDecimalsCache;
}

/// PositionToken.PRICE_SCALE.
export const PRICE_SCALE = 10n ** 18n;

export function resetChainClients(): void {
  publicClientInstance = undefined;
  deployerInstance = undefined;
  operatorInstance = undefined;
  usdgDecimalsCache = undefined;
}
