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

import { retry } from "../lib/async";
import { createLogger } from "../lib/logger";
import {
  DirectionEnum,
  erc20Abi,
  lendingPoolAbi,
  lendingPoolFactoryAbi,
  positionTokenAbi,
  positionTokenFactoryAbi,
  type DirectionName,
} from "./abi";
import {
  assetAddress,
  factoryAddress,
  lendingPoolFactoryAddress,
  liquidatorWallet,
  operatorWallet,
  publicClient,
  withWalletLock,
} from "./clients";

const log = createLogger("chain:write");

export interface ContractCall {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

export interface SendOptions {
  /// Called with the hash as soon as the transaction is broadcast, BEFORE the
  /// receipt is awaited -- the caller persists it there, so a crash while
  /// waiting resumes by checking the receipt instead of sending again. Retried
  /// (it is a DB write); a failure after the retries is logged, not thrown,
  /// because the transaction is already out.
  onSent?: (txHash: Hash) => Promise<void>;
}

/**
 * Simulate, send and wait for one transaction, holding the sender's queue slot
 * for the whole round trip so the next transaction from the same wallet gets
 * the next nonce. Simulating first turns a revert into a readable error before
 * any gas is spent -- with the custom errors in `abi`, viem decodes them by name.
 */
export async function sendTransaction(
  wallet: WalletClient,
  label: string,
  call: ContractCall,
  options: SendOptions = {},
): Promise<{ txHash: Hash; logs: Log[] }> {
  const account = wallet.account;
  if (!account) throw new Error(`${label}: wallet has no account`);

  return withWalletLock(account.address, async () => {
    const { request } = await publicClient().simulateContract({ ...call, account } as never);
    const gas = await gasWithBuffer({ ...call, account });
    const txHash = await wallet.writeContract({ ...(request as object), gas } as never);
    if (options.onSent) {
      await retry(() => options.onSent!(txHash), { attempts: 5, baseMs: 500, label: `${label} onSent` }).catch(
        (error) => log.error(`${label}: could not persist the sent tx hash`, { txHash, error: String(error) }),
      );
    }
    const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`${label} reverted (tx ${txHash})`);
    }
    return { txHash, logs: receipt.logs as Log[] };
  });
}

const send = sendTransaction;

/// eth_estimateGas plus GAS_BUFFER_BPS (default 30%). On Monad testnet an
/// exact estimate ran a LendingPool.withdrawCollateral out of gas after its
/// share transfer (2026-10-05, tx 0xf774dae3…); Monad also charges the full
/// limit, so the buffer is a small, bounded cost.
export async function gasWithBuffer(call: ContractCall & { account: unknown }): Promise<bigint> {
  const estimate = await publicClient().estimateContractGas(call as never);
  return (estimate * BigInt(10_000 + GAS_BUFFER_BPS)) / 10_000n;
}

const GAS_BUFFER_BPS = Math.max(0, Number(process.env.GAS_BUFFER_BPS ?? 3_000));

/// The receipt of a transaction sent earlier (resume path): success, reverted,
/// or not found yet.
export async function receiptStatus(txHash: Hash): Promise<"success" | "reverted" | "unknown"> {
  try {
    const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    return receipt.status;
  } catch {
    return "unknown";
  }
}

/**
 * The bytes32 the token stores as `venuePositionId`: one per entry order,
 * `perpl:<accountId>:<requestId>`. Only ever compared, never decoded -- the
 * readable string stays in `positions.venuePositionId`.
 */
export function venuePositionKey(perplAccountId: string, requestId: string): string {
  return `perpl:${perplAccountId}:${requestId}`;
}

export function venuePositionIdFor(perplAccountId: string, requestId: string): `0x${string}` {
  return keccak256(toHex(venuePositionKey(perplAccountId, requestId)));
}

export interface CreatePositionArgs {
  creator: Address;
  /// bytes32 market key.
  market: `0x${string}`;
  direction: DirectionName;
  leverage: number;
  /// The venue position's entry price, 1e18 fixed point (Exchange.getPosition,
  /// converted exactly as PerplReader converts it).
  entryPrice: bigint;
  /// The venue position's size, size6 -- must equal PerplReader.position().size.
  size: bigint;
  /// What the venue credited, asset base units.
  initialDeposit: bigint;
  /// keccak256("perpl:<accountId>:<requestId>") -- see {venuePositionIdFor}.
  venuePositionId: `0x${string}`;
  /// The slot's Perpl account id: the token reads its venue position from it.
  venueAccountId: bigint;
  /// The creator's SL/TP -- defaults for every holder. 1e18; 0n = none.
  defaultStopLoss: bigint;
  defaultTakeProfit: bigint;
}

/// PositionTokenFactory.createPosition -- the 11-argument signature. The token's
/// initializer checks the claimed trade against the real venue position held by
/// `venueAccountId`, then mints the whole initial supply to `creator`.
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
      args.venuePositionId,
      args.venueAccountId,
      args.defaultStopLoss,
      args.defaultTakeProfit,
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
  venuePositionId: `0x${string}`,
): Promise<Address | undefined> {
  const wanted = venuePositionId.toLowerCase();
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
      functionName: "venuePositionId",
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
  functionName:
    | "fulfillDepositRequest"
    | "fulfillRedeemRequest"
    | "close"
    | "applyFunding"
    | "settle"
    | "claimFor"
    | "recoverExcess"
    | "executeTrigger"
    | "retireDefaultTriggers",
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
 * the buyer, the asset paid straight to the redeemer -- so nothing follows it
 * but ledger writes. A revert with "no pending deposit"/"no pending redeem"
 * means the user cancelled first; see {isNoPendingRevert}.
 */
export async function fulfillDepositRequest(params: {
  positionToken: Address;
  controller: Address;
  /// The venue fill that grew the position, size6. 0 = added as margin only.
  addedSize: bigint;
  /// Its price, 1e18. 0 when addedSize is 0.
  fillPrice: bigint;
}): Promise<Hash> {
  // The contract prices the shares itself at navPerShare() -- no price passed.
  return operatorWrite(params.positionToken, "fulfillDepositRequest", [
    0n,
    params.controller,
    params.addedSize,
    params.fillPrice,
  ]);
}

export async function fulfillRedeemRequest(params: {
  positionToken: Address;
  controller: Address;
  /// The reduce-only fill on the venue, size6. 0 = paid from the buffer only.
  closedSize: bigint;
  fillPrice: bigint;
}): Promise<Hash> {
  return operatorWrite(params.positionToken, "fulfillRedeemRequest", [
    0n,
    params.controller,
    params.closedSize,
    params.fillPrice,
  ]);
}

/// The revert both fulfil functions raise once the controller has nothing
/// pending -- i.e. the user's cancel landed first. Not an error to retry.
export function isNoPendingRevert(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no pending (deposit|redeem)/i.test(message);
}

/// Exits one holder whose own SL/TP is breached at the LIVE venue mark, paying
/// `balanceOf(holder) x navPerShare()`. The token must already hold the payout
/// on top of pending buy-ins, or this reverts "insufficient assets".
export async function executeTrigger(params: {
  positionToken: Address;
  holder: Address;
  /// This holder's slice of the aggregate reduce-only fill, size6.
  closedSize: bigint;
  fillPrice: bigint;
}): Promise<Hash> {
  return operatorWrite(params.positionToken, "executeTrigger", [params.holder, params.closedSize, params.fillPrice]);
}

/// Only succeeds while a default level is breached at the live venue mark.
export async function retireDefaultTriggers(positionToken: Address): Promise<Hash> {
  return operatorWrite(positionToken, "retireDefaultTriggers", []);
}

/// Normal closes need the creator's on-chain requestClose() first; the
/// contract only waives that for `wasLiquidated`. The contract reads the final
/// mark from the venue itself (falling back to the cached mark only for a
/// liquidation); the operator supplies only the final cumulative funding.
export async function closePosition(params: {
  positionToken: Address;
  /// Asset base units, signed -- cumulative for the whole position.
  funding: bigint;
  wasLiquidated: boolean;
}): Promise<Hash> {
  return operatorWrite(params.positionToken, "close", [params.funding, params.wasLiquidated]);
}

/// Records the asset actually recovered from the venue. The token must already
/// hold `assets` on top of any pending buy-ins, or this reverts "settlement not funded".
export async function settle(positionToken: Address, assets: bigint): Promise<Hash> {
  return operatorWrite(positionToken, "settle", [assets]);
}

/// Pushes a settled holder's payout to them. The operator pays the gas; the
/// asset always goes to `holder`. Reverts for contract addresses.
export async function claimFor(positionToken: Address, holder: Address): Promise<Hash> {
  return operatorWrite(positionToken, "claimFor", [holder]);
}

/// Returns the backend's float -- whatever the settled token holds beyond
/// unclaimed payouts and pending buy-in refunds -- to `to`.
export async function recoverExcess(positionToken: Address, to: Address): Promise<Hash> {
  return operatorWrite(positionToken, "recoverExcess", [to]);
}

/// Sets the position's cumulative funding. Gated to the token's `operator`.
/// The mark is never reported -- the token reads it from the venue.
export async function applyFunding(params: {
  positionToken: Address;
  /// Asset base units, signed: cumulative for the whole position (the
  /// contract nets out `fundingSettled` itself).
  funding: bigint;
  /// Unix seconds; must be strictly greater than the token's
  /// lastFundingTimestamp and at most block.timestamp + 60, or the call reverts.
  timestamp: bigint;
}): Promise<Hash> {
  return operatorWrite(params.positionToken, "applyFunding", [params.funding, params.timestamp]);
}

// ---------------------------------------------------------------------------
// Reads used by the fulfilment flows
// ---------------------------------------------------------------------------

/// The contract's own NAV per share, PRICE_SCALE fixed point -- exactly the
/// price the fulfil functions settle at.
export async function navPerShare(positionToken: Address): Promise<bigint> {
  return (await publicClient().readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "navPerShare",
  })) as bigint;
}

/// The mark every valuation uses: the live venue mark, or the token's cached
/// one with `live == false` when the venue can't be read.
export async function currentMark(positionToken: Address): Promise<{ price: bigint; live: boolean }> {
  const [price, live] = (await publicClient().readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "currentMark",
  })) as readonly [bigint, boolean];
  return { price, live };
}

/// What LendingPool checks before opening new risk: a recent funding report
/// and a live venue mark.
export async function isPriceFresh(positionToken: Address): Promise<boolean> {
  return (await publicClient().readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "isPriceFresh",
  })) as boolean;
}

export interface TokenAccounting {
  capital: bigint;
  size: bigint;
  entryPrice: bigint;
  fundingAccrued: bigint;
  fundingSettled: bigint;
  direction: DirectionName;
  /// Unix seconds.
  lastFundingTimestamp: bigint;
}

/// The inputs of the token's value formula, for the funding reporter. Parallel
/// reads (no Multicall3 address is configured for the chain).
export async function tokenAccounting(positionToken: Address): Promise<TokenAccounting> {
  const read = <T>(functionName: string) =>
    publicClient().readContract({ address: positionToken, abi: positionTokenAbi, functionName } as never) as Promise<T>;
  const [capital, size, entryPrice, fundingAccrued, fundingSettled, direction, lastFundingTimestamp] =
    await Promise.all([
      read<bigint>("capital"),
      read<bigint>("size"),
      read<bigint>("entryPrice"),
      read<bigint>("fundingAccrued"),
      read<bigint>("fundingSettled"),
      read<number>("direction"),
      read<bigint>("lastFundingTimestamp"),
    ]);
  return {
    capital,
    size,
    entryPrice,
    fundingAccrued,
    fundingSettled,
    direction: Number(direction) === DirectionEnum.short ? "short" : "long",
    lastFundingTimestamp,
  };
}

/// The token's size/entry next to the venue's -- a risk view.
export async function venueDrift(positionToken: Address): Promise<{
  ourSize: bigint;
  venueSize: bigint;
  ourEntry: bigint;
  venueEntry: bigint;
  venueExists: boolean;
}> {
  const [ourSize, venueSize, ourEntry, venueEntry, venueExists] = (await publicClient().readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "venueDrift",
  })) as readonly [bigint, bigint, bigint, bigint, boolean];
  return { ourSize, venueSize, ourEntry, venueEntry, venueExists };
}

export interface OnChainPositionState {
  size: bigint;
  entryPrice: bigint;
  /// The token's currentMark(): the live venue mark, or the cached one.
  markPrice: bigint;
  capital: bigint;
  fundingAccrued: bigint;
  fundingSettled: bigint;
  totalAssets: bigint;
  totalSupply: bigint;
  closed: boolean;
}

/// Everything the buy-in/redeem sizing and the stats job read, in one go.
export async function readPositionState(positionToken: Address): Promise<OnChainPositionState> {
  const client = publicClient();
  const read = <T>(functionName: string) =>
    client.readContract({ address: positionToken, abi: positionTokenAbi, functionName } as never) as Promise<T>;
  const [size, entryPrice, mark, capital, fundingAccrued, fundingSettled, totalAssets, supply, closed] =
    await Promise.all([
      read<bigint>("size"),
      read<bigint>("entryPrice"),
      currentMark(positionToken),
      read<bigint>("capital"),
      read<bigint>("fundingAccrued"),
      read<bigint>("fundingSettled"),
      read<bigint>("totalAssets"),
      read<bigint>("totalSupply"),
      read<boolean>("closed"),
    ]);
  return {
    size,
    entryPrice,
    markPrice: mark.price,
    capital,
    fundingAccrued,
    fundingSettled,
    totalAssets,
    totalSupply: supply,
    closed,
  };
}

const leverageCache = new Map<string, number>();

/// PositionToken.leverage() -- set once in initialize, so cached. Every venue
/// order for a token is sent at this `lv`: Perpl re-margins the whole position
/// to each order's leverage (docs/perpl-findings.md#f-remargin).
export async function tokenLeverage(positionToken: Address): Promise<number> {
  const key = positionToken.toLowerCase();
  const cached = leverageCache.get(key);
  if (cached !== undefined) return cached;
  const leverage = Number(
    await publicClient().readContract({ address: positionToken, abi: positionTokenAbi, functionName: "leverage" }),
  );
  leverageCache.set(key, leverage);
  return leverage;
}

/// Asset sitting in the token for buyers whose requests are still pending --
/// theirs to take back on cancel, so never usable for a redeem payout.
export async function totalPendingDepositAssets(positionToken: Address): Promise<bigint> {
  return (await publicClient().readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "totalPendingDepositAssets",
  })) as bigint;
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

/// `(currentMark, fundingAccrued, lastFundingTimestamp)` in one read.
export async function getLastReport(
  positionToken: Address,
): Promise<{ markPrice: bigint; funding: bigint; lastFundingTimestamp: bigint }> {
  const [markPrice, funding, lastFundingTimestamp] = (await publicClient().readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "getLastReport",
  })) as readonly [bigint, bigint, bigint];
  return { markPrice, funding, lastFundingTimestamp };
}

export async function isClosed(positionToken: Address): Promise<boolean> {
  return (await publicClient().readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "closed",
  })) as boolean;
}

export async function readSettlement(
  positionToken: Address,
): Promise<{ settled: boolean; settlementAssets: bigint; claimedAssets: bigint }> {
  const read = <T>(functionName: string) =>
    publicClient().readContract({ address: positionToken, abi: positionTokenAbi, functionName } as never) as Promise<T>;
  const [settled, settlementAssets, claimedAssets] = await Promise.all([
    read<boolean>("settled"),
    read<bigint>("settlementAssets"),
    read<bigint>("claimedAssets"),
  ]);
  return { settled, settlementAssets, claimedAssets };
}

export async function shareBalanceOf(positionToken: Address, holder: Address): Promise<bigint> {
  return (await publicClient().readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "balanceOf",
    args: [holder],
  })) as bigint;
}

/// True for an address with deployed code -- `claimFor` refuses those.
export async function isContract(address: Address): Promise<boolean> {
  const code = await publicClient().getCode({ address });
  return code !== undefined && code !== "0x";
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
// Asset movements
// ---------------------------------------------------------------------------

export async function assetBalanceOf(account: Address): Promise<bigint> {
  return (await publicClient().readContract({
    address: assetAddress(),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  })) as bigint;
}

export async function transferAsset(
  wallet: WalletClient,
  to: Address,
  amount: bigint,
  options: SendOptions = {},
): Promise<Hash> {
  const { txHash } = await send(
    wallet,
    "asset transfer",
    { address: assetAddress(), abi: erc20Abi, functionName: "transfer", args: [to, amount] },
    options,
  );
  return txHash;
}

/// Only for a test token with an open mint (ASSET_MINTABLE=true).
export async function mintAsset(wallet: WalletClient, to: Address, amount: bigint): Promise<Hash> {
  const { txHash } = await send(wallet, "asset mint", {
    address: assetAddress(),
    abi: erc20Abi,
    functionName: "mint",
    args: [to, amount],
  });
  return txHash;
}

/**
 * Approve `spender` for MAX once, so every later pull is a single transaction.
 * Checked (cheaply) before each use rather than trusted.
 */
export async function ensureAllowance(
  wallet: WalletClient,
  spender: Address,
  amount: bigint,
  label = "asset approve",
): Promise<void> {
  const owner = wallet.account?.address;
  if (!owner) throw new Error("wallet has no account");
  const allowance = (await publicClient().readContract({
    address: assetAddress(),
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;
  if (allowance >= amount) return;

  const { txHash } = await send(wallet, label, {
    address: assetAddress(),
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, 2n ** 256n - 1n],
  });
  log.info("allowance granted", { owner, spender, txHash });
}

/**
 * The asset `Transfer`s a transaction emitted, and whether it succeeded. Only
 * logs emitted by the asset contract itself count -- a lookalike token's
 * Transfer carries the same topic.
 */
export async function assetTransfersIn(txHash: Hash): Promise<{
  status: "success" | "reverted";
  transfers: Array<{ from: Address; to: Address; value: bigint }>;
}> {
  const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  const asset = assetAddress().toLowerCase();
  const transfers = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" })
    .filter((entry) => entry.address.toLowerCase() === asset)
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

/// Seized shares of a settled position: take the payout directly.
export async function claimAsLiquidator(positionToken: Address): Promise<Hash> {
  const { txHash } = await send(liquidatorWallet(), "claim (liquidator)", {
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "claim",
  });
  return txHash;
}

/**
 * Queues seized collateral shares back into the asset through the same async
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
