import {
  keccak256,
  parseEventLogs,
  toHex,
  zeroAddress,
  type Address,
  type Hash,
  type Log,
  type WalletClient,
} from "viem";

import { createLogger } from "../lib/logger";
import {
  DirectionEnum,
  depositProxyAbi,
  erc20Abi,
  lendingPoolAbi,
  lendingPoolFactoryAbi,
  positionTokenAbi,
  positionTokenFactoryAbi,
  type DirectionName,
} from "./abi";
import {
  PRICE_SCALE,
  depositProxyAddress,
  factoryAddress,
  lendingPoolFactoryAddress,
  liquidatorWallet,
  operatorWallet,
  publicClient,
  usdgAddress,
  withWalletLock,
} from "./clients";

const log = createLogger("chain:write");

/**
 * Simulate, send and wait for one transaction, holding the sender's queue slot
 * for the whole round trip so the next transaction from the same wallet gets
 * the next nonce. Simulating first turns a revert into a readable error before
 * any gas is spent.
 */
async function send(
  wallet: WalletClient,
  label: string,
  call: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] },
): Promise<{ txHash: Hash; logs: Log[] }> {
  const account = wallet.account;
  if (!account) throw new Error(`${label}: wallet has no account`);

  return withWalletLock(account.address, async () => {
    const { request } = await publicClient().simulateContract({ ...call, account } as never);
    const txHash = await wallet.writeContract(request as never);
    const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`${label} reverted (tx ${txHash})`);
    }
    return { txHash, logs: receipt.logs as Log[] };
  });
}

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
  /// Actual fill price, 1e18 fixed point.
  entryPrice: bigint;
  /// Actual filled size, in USDG base units per unit of the asset (see
  /// onChainSize in services/openPosition.ts).
  size: bigint;
  /// What Arcus credited, USDG base units.
  initialDeposit: bigint;
  arcusOrderId: string;
}

/// PositionTokenFactory.createPosition -- the 8-argument signature. Mints the
/// whole initial supply to `creator`.
export async function createPosition(
  args: CreatePositionArgs,
): Promise<{ positionToken: Address; txHash: Hash }> {
  const { txHash, logs } = await send(operatorWallet(), "createPosition", {
    address: factoryAddress(),
    abi: positionTokenFactoryAbi,
    functionName: "createPosition",
    args: [
      args.creator,
      args.market,
      DirectionEnum[args.direction],
      BigInt(args.leverage),
      args.entryPrice,
      args.size,
      args.initialDeposit,
      arcusPositionIdFor(args.arcusOrderId),
    ],
  });

  const created = parseEventLogs({ abi: positionTokenFactoryAbi, logs, eventName: "PositionCreated" })[0];
  if (!created) {
    throw new Error(`createPosition succeeded but emitted no PositionCreated (tx ${txHash})`);
  }

  const positionToken = created.args.positionToken;
  log.info("position token created", { positionToken, txHash, creator: args.creator });
  return { positionToken, txHash };
}

/**
 * A token the Factory already minted for this exact trade, if any. Checked
 * before every createPosition retry: a crash between the transaction landing
 * and its address being saved must not mint a second token for one trade.
 */
export async function findExistingPositionToken(
  creator: Address,
  arcusOrderId: string,
): Promise<Address | undefined> {
  const wanted = arcusPositionIdFor(arcusOrderId).toLowerCase();
  const tokens = (await publicClient().readContract({
    address: factoryAddress(),
    abi: positionTokenFactoryAbi,
    functionName: "getPositionsByCreator",
    args: [creator],
  })) as readonly Address[];

  // Newest last; a retry is almost always about the most recent one.
  for (const token of [...tokens].reverse()) {
    const id = (await publicClient().readContract({
      address: token,
      abi: positionTokenAbi,
      functionName: "arcusPositionId",
    })) as `0x${string}`;
    if (id.toLowerCase() === wanted) return token;
  }
  return undefined;
}

/**
 * The token's LendingPool, creating it if there is none yet.
 *
 * createPool is permissionless and allows duplicates, so on a retry -- or if
 * someone else already created one -- the existing primary pool is reused
 * rather than splitting liquidity across a second. Must only ever be called
 * once createPosition has confirmed: LendingPool.initialize reads the token's
 * positionInfo() to fix its risk tier.
 */
export async function ensureLendingPool(positionToken: Address): Promise<Address> {
  const existing = (await publicClient().readContract({
    address: lendingPoolFactoryAddress(),
    abi: lendingPoolFactoryAbi,
    functionName: "primaryPool",
    args: [positionToken],
  })) as Address;
  if (existing !== zeroAddress) return existing;

  const { txHash, logs } = await send(operatorWallet(), "createPool", {
    address: lendingPoolFactoryAddress(),
    abi: lendingPoolFactoryAbi,
    functionName: "createPool",
    args: [positionToken],
  });

  const created = parseEventLogs({ abi: lendingPoolFactoryAbi, logs, eventName: "PoolCreated" })[0];
  if (!created) throw new Error(`createPool succeeded but emitted no PoolCreated (tx ${txHash})`);

  log.info("lending pool created", { positionToken, pool: created.args.pool, txHash });
  return created.args.pool;
}

// ---------------------------------------------------------------------------
// Operator calls
// ---------------------------------------------------------------------------

async function operatorWrite(
  address: Address,
  functionName: "fulfillDepositRequest" | "fulfillRedeemRequest" | "close" | "applyReport",
  args: readonly unknown[],
): Promise<Hash> {
  const { txHash } = await send(operatorWallet(), functionName, {
    address,
    abi: positionTokenAbi,
    functionName,
    args,
  });
  return txHash;
}

/**
 * `requestId` is always 0: the ERC7540 admin strategy tracks pending state per
 * controller rather than in a per-request queue, so `controller` is what
 * identifies whose request is being fulfilled.
 *
 * The fulfil settles in the same transaction -- shares are minted straight to
 * the buyer, USDG paid straight to the redeemer -- so nothing follows it but
 * ledger writes. A revert with "no pending deposit"/"no pending redeem" means
 * the user cancelled first; see {isNoPendingRevert}.
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

/// The revert both fulfil functions raise once the controller has nothing
/// pending -- i.e. the user's cancel landed first. Not an error to retry.
export function isNoPendingRevert(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no pending (deposit|redeem)/i.test(message);
}

/// Normal closes need the creator's on-chain requestClose() first; the
/// contract only waives that for `wasLiquidated`.
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
 * fulfil calls take: `totalAssets() * 1e18 / totalSupply()`. Shares and USDG
 * share decimals (no ERC-4626 offset), so this is USDG per whole share at 1e18.
 */
export async function navPerShare(positionToken: Address): Promise<bigint> {
  const client = publicClient();
  const [assets, supply] = await Promise.all([
    client.readContract({ address: positionToken, abi: positionTokenAbi, functionName: "totalAssets" }) as Promise<bigint>,
    client.readContract({ address: positionToken, abi: positionTokenAbi, functionName: "totalSupply" }) as Promise<bigint>,
  ]);
  if (supply === 0n) throw new Error(`${positionToken} has zero supply; no NAV per share`);
  const nav = (assets * PRICE_SCALE) / supply;
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

// ---------------------------------------------------------------------------
// USDG movements
// ---------------------------------------------------------------------------

export async function usdgBalanceOf(account: Address): Promise<bigint> {
  return (await publicClient().readContract({
    address: usdgAddress(),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  })) as bigint;
}

export async function transferUsdg(wallet: WalletClient, to: Address, amount: bigint): Promise<Hash> {
  const { txHash } = await send(wallet, "USDG transfer", {
    address: usdgAddress(),
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
  });
  return txHash;
}

/// Testnet only: USDG has an open mint. See the known limitations in
/// services/margin.ts for why the backend needs it.
export async function mintUsdg(wallet: WalletClient, to: Address, amount: bigint): Promise<Hash> {
  const { txHash } = await send(wallet, "USDG mint", {
    address: usdgAddress(),
    abi: erc20Abi,
    functionName: "mint",
    args: [to, amount],
  });
  return txHash;
}

/**
 * One-time per internal wallet, and again whenever an Arcus reset moves the
 * proxy: approve the deposit proxy for MAX so every deposit after is a single
 * transaction. Checked (cheaply) before each deposit rather than trusted.
 */
export async function ensureDepositProxyApproval(wallet: WalletClient, amount: bigint): Promise<void> {
  const owner = wallet.account?.address;
  if (!owner) throw new Error("wallet has no account");
  const allowance = (await publicClient().readContract({
    address: usdgAddress(),
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, depositProxyAddress()],
  })) as bigint;
  if (allowance >= amount) return;

  const { txHash } = await send(wallet, "USDG approve (deposit proxy)", {
    address: usdgAddress(),
    abi: erc20Abi,
    functionName: "approve",
    args: [depositProxyAddress(), 2n ** 256n - 1n],
  });
  log.info("deposit proxy approved", { owner, txHash });
}

/// `initiateDeposit(owner = signer, accountIndex, USDG, amount)` -- the only way
/// to route funds to a specific subaccount; `owner` must be the signer.
export async function initiateArcusDeposit(
  wallet: WalletClient,
  accountIndex: number,
  amount: bigint,
): Promise<Hash> {
  const owner = wallet.account?.address;
  if (!owner) throw new Error("wallet has no account");
  const { txHash } = await send(wallet, "initiateDeposit", {
    address: depositProxyAddress(),
    abi: depositProxyAbi,
    functionName: "initiateDeposit",
    args: [owner, accountIndex, usdgAddress(), amount],
  });
  return txHash;
}

/**
 * The USDG `Transfer`s a payment transaction emitted, and whether it succeeded.
 * Only logs emitted by the USDG contract itself count -- a lookalike token's
 * Transfer carries the same topic.
 */
export async function usdgTransfersIn(txHash: Hash): Promise<{
  status: "success" | "reverted";
  transfers: Array<{ from: Address; to: Address; value: bigint }>;
}> {
  const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  const usdg = usdgAddress().toLowerCase();
  const transfers = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" })
    .filter((entry) => entry.address.toLowerCase() === usdg)
    .map((entry) => ({ from: entry.args.from, to: entry.args.to, value: entry.args.value }));
  return { status: receipt.status, transfers };
}

// ---------------------------------------------------------------------------
// Lending-side liquidation bot
// ---------------------------------------------------------------------------

export async function healthFactorFor(pool: Address, borrower: Address): Promise<bigint> {
  return (await publicClient().readContract({
    address: pool,
    abi: lendingPoolAbi,
    functionName: "healthFactor",
    args: [borrower],
  })) as bigint;
}

/// 0 when the borrower is healthy; otherwise the close-factor/dust-capped
/// amount {liquidate} will currently accept.
export async function maxLiquidatableDebtFor(pool: Address, borrower: Address): Promise<bigint> {
  return (await publicClient().readContract({
    address: pool,
    abi: lendingPoolAbi,
    functionName: "maxLiquidatableDebt",
    args: [borrower],
  })) as bigint;
}

export async function debtAssetFor(pool: Address): Promise<Address> {
  return (await publicClient().readContract({
    address: pool,
    abi: lendingPoolAbi,
    functionName: "debtAsset",
  })) as Address;
}

/**
 * Approves `pool` to pull `requiredAmount` of its debt asset from the
 * liquidator wallet, but only if the standing allowance is not already
 * enough. Approves `type(uint256).max` when it does write, matching the pool's
 * own one-time `forceApprove` against the vault, so this only ever needs to
 * run once per (liquidator, pool) pair.
 */
export async function ensureLiquidatorApproval(pool: Address, requiredAmount: bigint): Promise<void> {
  const wallet = liquidatorWallet();
  const account = wallet.account;
  if (!account) throw new Error("liquidator wallet has no account");

  const debtAsset = await debtAssetFor(pool);
  const allowance = (await publicClient().readContract({
    address: debtAsset,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, pool],
  })) as bigint;

  if (allowance >= requiredAmount) return;

  const { txHash } = await send(wallet, "approve", {
    address: debtAsset,
    abi: erc20Abi,
    functionName: "approve",
    args: [pool, 2n ** 256n - 1n],
  });
  log.info("liquidator approval granted", { pool, debtAsset, txHash });
}

/// PERMISSIONLESS on-chain -- signed by the liquidator wallet, which holds none
/// of the operator's roles.
export async function liquidate(
  pool: Address,
  borrower: Address,
  repayAmount: bigint,
): Promise<{ txHash: Hash; seizedShares: bigint }> {
  const { txHash, logs } = await send(liquidatorWallet(), "liquidate", {
    address: pool,
    abi: lendingPoolAbi,
    functionName: "liquidate",
    args: [borrower, repayAmount],
  });
  const seized = parseEventLogs({ abi: lendingPoolAbi, logs, eventName: "Liquidated" })[0];
  return { txHash, seizedShares: seized?.args.seizedShares ?? 0n };
}

/**
 * Queues seized collateral shares back into USDG through the same async
 * ERC-7540 redeem flow every other holder uses -- `controller` and `owner`
 * are both the liquidator wallet itself (as requestRedeem requires), since it
 * already holds the shares outright (LendingPool.liquidate() moves them as a
 * plain ERC-20 transfer, not a redeem). The indexer already watches every open
 * PositionToken for `RedeemRequested`, so this call alone is what puts the
 * request in front of the existing margin-remove orchestration.
 */
export async function requestRedeemAsLiquidator(
  positionToken: Address,
  shares: bigint,
): Promise<Hash> {
  const wallet = liquidatorWallet();
  const account = wallet.account;
  if (!account) throw new Error("liquidator wallet has no account");

  const { txHash } = await send(wallet, "requestRedeem (liquidator)", {
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "requestRedeem",
    args: [shares, account.address, account.address],
  });
  return txHash;
}
