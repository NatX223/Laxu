import { decodeEventLog, keccak256, toHex, type Address, type Hash } from "viem";

import { createLogger } from "../lib/logger";
import { DirectionEnum, positionTokenAbi, positionTokenFactoryAbi, type DirectionName } from "./abi";
import { PRICE_SCALE, arcusOperatorWallet, deployerWallet, factoryAddress, publicClient } from "./clients";

const log = createLogger("chain:write");

/**
 * Arcus exposes no position identifier of its own -- the entry order id is the
 * closest thing. It is a variable-length string, so it is hashed into the
 * bytes32 the contract wants. The readable id stays in `positions.arcusOrderId`;
 * this value is only ever compared, never decoded.
 */
export function arcusPositionIdFor(orderId: string): `0x${string}` {
  return keccak256(toHex(orderId));
}

export interface CreatePositionArgs {
  creator: Address;
  /// bytes32 market key.
  market: `0x${string}`;
  direction: DirectionName;
  leverage: number;
  /// 1e18 fixed point.
  entryPrice: bigint;
  /// 1e18 fixed point.
  size: bigint;
  /// USDG base units.
  initialDeposit: bigint;
  arcusOrderId: string;
  creatorFeeBps: number;
  nickname: string;
}

export async function createPosition(
  args: CreatePositionArgs,
): Promise<{ positionToken: Address; txHash: Hash }> {
  const wallet = deployerWallet();
  const account = wallet.account;
  if (!account) throw new Error("deployer wallet has no account");

  const params = [
    args.creator,
    args.market,
    DirectionEnum[args.direction],
    BigInt(args.leverage),
    args.entryPrice,
    args.size,
    args.initialDeposit,
    arcusPositionIdFor(args.arcusOrderId),
    BigInt(args.creatorFeeBps),
    args.nickname,
  ] as const;

  // Simulate first: createPosition is gated to the deployer, and a revert here
  // is far cheaper to diagnose than a failed transaction after the user's funds
  // are already sitting on Arcus.
  const { request } = await publicClient().simulateContract({
    address: factoryAddress(),
    abi: positionTokenFactoryAbi,
    functionName: "createPosition",
    args: params,
    account,
  });

  const txHash = await wallet.writeContract(request);
  const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`createPosition reverted (tx ${txHash})`);
  }

  const positionToken = positionTokenFromReceipt(receipt.logs);
  if (!positionToken) {
    throw new Error(`createPosition succeeded but emitted no PositionCreated (tx ${txHash})`);
  }

  log.info("position token created", { positionToken, txHash, creator: args.creator });
  return { positionToken, txHash };
}

function positionTokenFromReceipt(logs: readonly { data: `0x${string}`; topics: readonly `0x${string}`[] }[]):
  | Address
  | undefined {
  for (const entry of logs) {
    try {
      const decoded = decodeEventLog({
        abi: positionTokenFactoryAbi,
        data: entry.data,
        topics: entry.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
      });
      if (decoded.eventName === "PositionCreated") {
        return (decoded.args as { positionToken: Address }).positionToken;
      }
    } catch {
      // Not a factory event -- skip.
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Operator calls
// ---------------------------------------------------------------------------

async function operatorWrite(
  address: Address,
  functionName: "fulfillDepositRequest" | "fulfillRedeemRequest" | "close" | "applyReport",
  args: readonly unknown[],
): Promise<Hash> {
  const wallet = arcusOperatorWallet();
  const account = wallet.account;
  if (!account) throw new Error("arcusOperator wallet has no account");

  const { request } = await publicClient().simulateContract({
    address,
    abi: positionTokenAbi,
    functionName,
    args: args as never,
    account,
  });

  const txHash = await wallet.writeContract(request);
  const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`${functionName} reverted (tx ${txHash})`);
  }
  return txHash;
}

/**
 * `requestId` is always 0: the ERC7540 admin strategy tracks pending state per
 * controller rather than in a per-request queue, so `controller` is what
 * identifies whose request is being fulfilled.
 */
export async function fulfillDepositRequest(params: {
  positionToken: Address;
  controller: Address;
  /// NAV per share, PRICE_SCALE fixed point.
  fulfillmentPrice: bigint;
}): Promise<Hash> {
  return operatorWrite(params.positionToken, "fulfillDepositRequest", [
    0n,
    params.controller,
    params.fulfillmentPrice,
  ]);
}

export async function fulfillRedeemRequest(params: {
  positionToken: Address;
  controller: Address;
  fulfillmentPrice: bigint;
}): Promise<Hash> {
  return operatorWrite(params.positionToken, "fulfillRedeemRequest", [
    0n,
    params.controller,
    params.fulfillmentPrice,
  ]);
}

export async function closePosition(params: {
  positionToken: Address;
  /// 1e18 fixed point.
  finalMarkPrice: bigint;
  /// USDG base units, signed.
  finalFunding: bigint;
  wasLiquidated: boolean;
}): Promise<Hash> {
  return operatorWrite(params.positionToken, "close", [
    params.finalMarkPrice,
    params.finalFunding,
    params.wasLiquidated,
  ]);
}

/// Pushes a new mark price/funding onto a live position. Gated to `arcusOperator`
/// on-chain -- the same wallet that already fulfils deposits/redeems and closes.
export async function applyReport(params: {
  positionToken: Address;
  /// 1e18 fixed point.
  markPrice: bigint;
  /// USDG base units, signed.
  funding: bigint;
  /// Unix seconds; must be strictly greater than the position's current
  /// lastReportTimestamp or the call reverts.
  timestamp: bigint;
}): Promise<Hash> {
  return operatorWrite(params.positionToken, "applyReport", [
    params.markPrice,
    params.funding,
    params.timestamp,
  ]);
}

// ---------------------------------------------------------------------------
// Reads used by the fulfilment flows
// ---------------------------------------------------------------------------

/**
 * NAV per share in PRICE_SCALE fixed point -- the `fulfillmentPrice` both
 * fulfil calls take.
 *
 * `convertToAssets(PRICE_SCALE)` is exactly this quantity: assets per 1e18
 * shares. It stays dimensionally correct whatever the asset's decimals are,
 * which reading totalAssets/totalSupply by hand would not.
 */
export async function navPerShare(positionToken: Address): Promise<bigint> {
  const value = await publicClient().readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "convertToAssets",
    args: [PRICE_SCALE],
  });
  const nav = value as bigint;
  if (nav === 0n) {
    throw new Error(`NAV per share on ${positionToken} is zero; refusing to fulfil at price 0`);
  }
  return nav;
}

export async function pendingDeposit(positionToken: Address, controller: Address): Promise<bigint> {
  return (await publicClient().readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "pendingDepositRequest",
    args: [0n, controller],
  })) as bigint;
}

export async function pendingRedeem(positionToken: Address, controller: Address): Promise<bigint> {
  return (await publicClient().readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "pendingRedeemRequest",
    args: [0n, controller],
  })) as bigint;
}

/// Combined read the reporting job uses to decide whether a position's price has
/// moved enough (or gone stale enough) to be worth a fresh {applyReport} call.
export async function getLastReport(
  positionToken: Address,
): Promise<{ markPrice: bigint; funding: bigint; timestamp: bigint }> {
  const [markPrice, funding, timestamp] = (await publicClient().readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "getLastReport",
  })) as [bigint, bigint, bigint];
  return { markPrice, funding, timestamp };
}

export async function isClosed(positionToken: Address): Promise<boolean> {
  return (await publicClient().readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "closed",
  })) as boolean;
}

/**
 * The close-access-control rule: only usable when the creator holds 100% of
 * supply. Checked here because `requestClose()` does not exist on-chain yet, so
 * nothing else is enforcing it.
 */
export async function creatorHoldsEntireSupply(positionToken: Address): Promise<{
  ok: boolean;
  creator: Address;
  creatorBalance: bigint;
  totalSupply: bigint;
}> {
  const client = publicClient();
  const [creator, totalSupply] = await Promise.all([
    client.readContract({
      address: positionToken,
      abi: positionTokenAbi,
      functionName: "creator",
    }) as Promise<Address>,
    client.readContract({
      address: positionToken,
      abi: positionTokenAbi,
      functionName: "totalSupply",
    }) as Promise<bigint>,
  ]);

  const creatorBalance = (await client.readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "balanceOf",
    args: [creator],
  })) as bigint;

  return { ok: totalSupply > 0n && creatorBalance === totalSupply, creator, creatorBalance, totalSupply };
}

export async function totalSupply(positionToken: Address): Promise<bigint> {
  return (await publicClient().readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "totalSupply",
  })) as bigint;
}

export async function positionSizeOnChain(positionToken: Address): Promise<bigint> {
  return (await publicClient().readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "size",
  })) as bigint;
}
