import type { Address, Hash, WalletClient } from "viem";

import { publicClient } from "../../chain/clients";
import { ensureAllowance, sendTransaction, type SendOptions } from "../../chain/writes";
import { perplExchangeAbi } from "./abi";
import { exchangeAddress } from "./config";

/**
 * viem wrappers for the slice of Perpl's Exchange contract Laxu uses. Reads go
 * through the shared public client; writes are sent from the SLOT wallet
 * (only an account's own wallet can create, fund, withdraw from or toggle
 * forwarding on it), through the per-wallet nonce queue in chain/clients.ts.
 * The ABI carries Perpl's custom errors, so a revert surfaces by name.
 *
 * All `*CNS` values are collateral base units at `collateralDecimals`; see
 * units.ts for the conversion to asset units.
 */

export interface AccountInfo {
  accountId: bigint;
  balanceCNS: bigint;
  lockedBalanceCNS: bigint;
  frozen: number;
  accountAddr: Address;
}

export interface PositionInfo {
  accountId: bigint;
  positionType: number;
  depositCNS: bigint;
  pricePNS: bigint;
  lotLNS: bigint;
  entryBlock: bigint;
  pnlCNS: bigint;
  deltaPnlCNS: bigint;
  premiumPnlCNS: bigint;
}

export interface PerpetualInfo {
  name: string;
  symbol: string;
  priceDecimals: bigint;
  lotDecimals: bigint;
  markPNS: bigint;
  /// Unix seconds.
  markTimestamp: bigint;
  refPriceMaxAgeSec: bigint;
  status: number;
}

// --- Reads -----------------------------------------------------------------------

/// The account owned by `owner`; `accountId == 0` means none exists yet.
export async function getAccountByAddr(owner: Address): Promise<AccountInfo> {
  const info = (await publicClient().readContract({
    address: exchangeAddress(),
    abi: perplExchangeAbi,
    functionName: "getAccountByAddr",
    args: [owner],
  })) as unknown as AccountInfo;
  return {
    accountId: info.accountId,
    balanceCNS: info.balanceCNS,
    lockedBalanceCNS: info.lockedBalanceCNS,
    frozen: Number(info.frozen),
    accountAddr: info.accountAddr,
  };
}

/// The position `accountId` holds on `perpId` -- the same read PerplReader
/// makes for the contracts -- plus the exchange's mark for it.
export async function getPosition(
  perpId: bigint,
  accountId: bigint,
): Promise<{ position: PositionInfo; markPricePNS: bigint; markPriceValid: boolean }> {
  const [position, markPricePNS, markPriceValid] = (await publicClient().readContract({
    address: exchangeAddress(),
    abi: perplExchangeAbi,
    functionName: "getPosition",
    args: [perpId, accountId],
  })) as unknown as [PositionInfo, bigint, boolean];
  return {
    position: {
      accountId: position.accountId,
      positionType: Number(position.positionType),
      depositCNS: position.depositCNS,
      pricePNS: position.pricePNS,
      lotLNS: position.lotLNS,
      entryBlock: position.entryBlock,
      pnlCNS: position.pnlCNS,
      deltaPnlCNS: position.deltaPnlCNS,
      premiumPnlCNS: position.premiumPnlCNS,
    },
    markPricePNS,
    markPriceValid,
  };
}

export async function getPerpetualInfo(perpId: bigint): Promise<PerpetualInfo> {
  const info = (await publicClient().readContract({
    address: exchangeAddress(),
    abi: perplExchangeAbi,
    functionName: "getPerpetualInfo",
    args: [perpId],
  })) as unknown as PerpetualInfo;
  return {
    name: info.name,
    symbol: info.symbol,
    priceDecimals: info.priceDecimals,
    lotDecimals: info.lotDecimals,
    markPNS: info.markPNS,
    markTimestamp: info.markTimestamp,
    refPriceMaxAgeSec: info.refPriceMaxAgeSec,
    status: Number(info.status),
  };
}

export async function readExchangeInfo(): Promise<{ collateralDecimals: bigint; collateralToken: Address }> {
  const result = (await publicClient().readContract({
    address: exchangeAddress(),
    abi: perplExchangeAbi,
    functionName: "getExchangeInfo",
  })) as unknown as readonly [bigint, bigint, bigint, bigint, Address, Address];
  return { collateralDecimals: result[3], collateralToken: result[4] };
}

export async function getMinAccountOpenCNS(): Promise<bigint> {
  return (await publicClient().readContract({
    address: exchangeAddress(),
    abi: perplExchangeAbi,
    functionName: "getMinAccountOpenCNS",
  })) as bigint;
}

export async function isHalted(): Promise<boolean> {
  return (await publicClient().readContract({
    address: exchangeAddress(),
    abi: perplExchangeAbi,
    functionName: "isHalted",
  })) as boolean;
}

/// The exchange-wide withdrawal rate limit at `blockNumber`.
export async function getWithdrawAllowanceData(blockNumber: bigint): Promise<{
  allowanceCNS: bigint;
  expiryBlock: bigint;
  lastAllowanceBlock: bigint;
  cnsPerBlock: bigint;
}> {
  const [allowanceCNS, expiryBlock, lastAllowanceBlock, cnsPerBlock] = (await publicClient().readContract({
    address: exchangeAddress(),
    abi: perplExchangeAbi,
    functionName: "getWithdrawAllowanceData",
    args: [blockNumber],
  })) as unknown as readonly [bigint, bigint, bigint, bigint];
  return { allowanceCNS, expiryBlock, lastAllowanceBlock, cnsPerBlock };
}

// --- Writes (from the slot wallet) -------------------------------------------------

function exchangeCall(functionName: string, args: readonly unknown[]) {
  return { address: exchangeAddress(), abi: perplExchangeAbi as readonly unknown[], functionName, args };
}

/// One-time per wallet: `approve(exchange, MAX)`, so deposits and
/// createAccount can pull the asset.
export async function ensureExchangeApproval(wallet: WalletClient, amount: bigint): Promise<void> {
  await ensureAllowance(wallet, exchangeAddress(), amount, "asset approve (Perpl exchange)");
}

export async function createAccount(wallet: WalletClient, amountCNS: bigint, options?: SendOptions): Promise<Hash> {
  const { txHash } = await sendTransaction(wallet, "Perpl createAccount", exchangeCall("createAccount", [amountCNS]), options);
  return txHash;
}

/// Credited to the account in the same transaction.
export async function depositCollateral(wallet: WalletClient, amountCNS: bigint, options?: SendOptions): Promise<Hash> {
  const { txHash } = await sendTransaction(
    wallet,
    "Perpl depositCollateral",
    exchangeCall("depositCollateral", [amountCNS]),
    options,
  );
  return txHash;
}

/// Pays the account's own wallet in the same transaction. Subject to the
/// exchange-wide rate limit (getWithdrawAllowanceData) -- a revert there is
/// retryable, nothing moved.
export async function withdrawCollateral(wallet: WalletClient, amountCNS: bigint, options?: SendOptions): Promise<Hash> {
  const { txHash } = await sendTransaction(
    wallet,
    "Perpl withdrawCollateral",
    exchangeCall("withdrawCollateral", [amountCNS]),
    options,
  );
  return txHash;
}

/// Idempotent. There is no on-chain getter for the flag; the API's
/// `Account.fw` reports it.
export async function allowOrderForwarding(wallet: WalletClient, allow: boolean): Promise<Hash> {
  const { txHash } = await sendTransaction(wallet, "Perpl allowOrderForwarding", exchangeCall("allowOrderForwarding", [allow]));
  return txHash;
}
