import type { Address, Hash, WalletClient } from "viem";

import { getAccount, getAccountTransferUpdates, submitWithdrawal } from "../arcus/client";
import { signWithdraw } from "../arcus/eip712";
import { unixNanos } from "../arcus/signing";
import type { AccountTransferUpdate } from "../arcus/types";
import { QUOTE_QUANTUMS_PER_DOLLAR } from "../arcus/types";
import { internalWallet, usdgDecimals } from "../chain/clients";
import {
  ensureDepositProxyApproval,
  initiateArcusDeposit,
  mintUsdg,
} from "../chain/writes";
import { config } from "../config/env";
import { sleep } from "../lib/async";
import { toBaseUnits } from "../lib/decimal";
import { createLogger } from "../lib/logger";
import { operatorEvmKey, type SlotWithWallet } from "./allocator";
import { dollarsToQuantums } from "./sweep";

const log = createLogger("arcus-funding");

/**
 * Money movements made by a slot's internal Arcus wallet itself.
 *
 * Arcus's deposit proxy requires `owner` to be the signer, so only the wallet
 * that owns a subaccount can fund it -- a creator cannot deposit into Laxu's
 * subaccount directly. The creator pays the internal wallet a plain USDG
 * transfer; the internal wallet then calls `initiateDeposit` with the slot's
 * `accountIndex`, which is what routes the money to the right subaccount.
 *
 * Every on-chain send goes through the per-wallet queue in chain/writes.ts:
 * up to ten slots share one internal wallet.
 */

export function walletForSlot(slot: SlotWithWallet): WalletClient {
  return internalWallet(operatorEvmKey(slot), slot.operatorWallet.evmSignerRef);
}

/// Epoch microseconds, the unit Arcus's transfer feed filters `from` on.
export function toMicros(date: Date): bigint {
  return BigInt(date.getTime()) * 1000n;
}

/// USDG base units as Arcus quote quantums (1e9 = $1).
export async function baseUnitsToQuantums(amount: bigint): Promise<bigint> {
  const decimals = await usdgDecimals();
  return (amount * QUOTE_QUANTUMS_PER_DOLLAR) / 10n ** BigInt(decimals);
}

/**
 * Approve (once) and `initiateDeposit` into the slot's own subaccount. Returns
 * as soon as the transaction confirms -- the Arcus credit follows separately,
 * see {waitForCredit}.
 */
export async function depositToSubaccount(slot: SlotWithWallet, amount: bigint): Promise<Hash> {
  const wallet = walletForSlot(slot);
  await ensureDepositProxyApproval(wallet, amount);
  const txHash = await initiateArcusDeposit(wallet, slot.accountIndex, amount);
  log.info("initiateDeposit confirmed", {
    slotId: slot.id,
    accountIndex: slot.accountIndex,
    amount: amount.toString(),
    txHash,
  });
  return txHash;
}

/// The first APPLIED USDG deposit to this subaccount since `since`, if any.
export async function findCredit(
  slot: SlotWithWallet,
  since: Date,
): Promise<AccountTransferUpdate | undefined> {
  const updates = await getAccountTransferUpdates(slot.operatorWallet.address, slot.accountIndex, {
    limit: 50,
    from: toMicros(since),
  });
  return updates
    .filter(
      (update) =>
        update.type === "DEPOSIT" &&
        // A rejected transfer reports the pre-op balance and moved nothing.
        update.status === "APPLIED" &&
        // Spot-asset deposits carry a size in the asset's own units, not USD.
        !(update.spotAssetId && update.spotAssetId > 0) &&
        // Re-checked: a stale page could carry another subaccount.
        update.accountIndex === slot.accountIndex,
    )
    .sort((a, b) => a.createdAt - b.createdAt)[0];
}

/**
 * Poll until Arcus credits a deposit to this exact subaccount, usually within a
 * minute. `since` bounds the search to deposits made for this request: the
 * slot was exclusively reserved from then on, so any credit after it is ours.
 * Returns the credited amount in USDG base units.
 */
export async function waitForCredit(
  slot: SlotWithWallet,
  since: Date,
  timeoutMs = config.arcusCreditTimeoutMs,
): Promise<{ transferId: string; credited: bigint }> {
  const decimals = await usdgDecimals();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const credit = await findCredit(slot, since);
    if (credit) {
      return { transferId: credit.id, credited: toBaseUnits(credit.amount, decimals) };
    }
    await sleep(config.depositPollIntervalMs);
  }

  throw new Error(
    `Arcus did not credit a deposit on ${slot.operatorWallet.address} index ${slot.accountIndex} within ${Math.round(
      timeoutMs / 1000,
    )}s`,
  );
}

/**
 * Testnet only (USDG has an open mint): fund a subaccount with the backend's
 * own USDG. Buy-in USDG stays inside the PositionToken -- there is no function
 * to move it to Arcus -- so the Arcus-side margin increase for a buy-in is
 * funded here instead. Mainnet needs a proper operator-only sweep.
 */
export async function fundSubaccountFromMint(
  slot: SlotWithWallet,
  amount: bigint,
): Promise<{ credited: bigint }> {
  const wallet = walletForSlot(slot);
  const since = new Date();
  await mintUsdg(wallet, slot.operatorWallet.address as Address, amount);
  await depositToSubaccount(slot, amount);
  const { credited } = await waitForCredit(slot, since);
  return { credited };
}

/**
 * Withdraw USDG from the slot's subaccount back to its internal wallet
 * on-chain (withdraw-to-self is the only kind Arcus offers). Capped at the
 * subaccount's free collateral. Returns the withdrawal id and the base-unit
 * amount requested.
 */
export async function withdrawToInternalWallet(
  slot: SlotWithWallet,
  amount: bigint,
): Promise<{ withdrawalId: string; amount: bigint }> {
  const decimals = await usdgDecimals();
  const account = await getAccount(slot.operatorWallet.address, slot.accountIndex);
  const free = account ? toBaseUnits(account.freeCollateral ?? "0", decimals) : 0n;
  const withdraw = amount < free ? amount : free;
  if (withdraw <= 0n) {
    throw new Error(`Nothing withdrawable on index ${slot.accountIndex} (free collateral ${free})`);
  }

  const quantums = await baseUnitsToQuantums(withdraw);
  const nonce = unixNanos().toString();
  const signature = await signWithdraw({
    privateKey: operatorEvmKey(slot),
    ethereumAddress: slot.operatorWallet.address,
    accountIndex: slot.accountIndex,
    amount: quantums,
    nonce,
  });

  const result = await submitWithdrawal({
    ethereumAddress: slot.operatorWallet.address,
    accountIndex: slot.accountIndex,
    amount: quantums.toString(),
    nonce,
    signature,
  });

  log.info("withdrawal submitted", {
    slotId: slot.id,
    accountIndex: slot.accountIndex,
    amount: withdraw.toString(),
    withdrawalId: result.withdrawalId,
  });
  return { withdrawalId: result.withdrawalId, amount: withdraw };
}

/**
 * Wait for a withdrawal's terminal state on the transfer feed. Returns the
 * applied amount in base units; throws on a rejection.
 */
export async function waitForWithdrawal(
  slot: SlotWithWallet,
  withdrawalId: string,
  since: Date,
  timeoutMs = config.arcusCreditTimeoutMs,
): Promise<bigint> {
  const decimals = await usdgDecimals();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const updates = await getAccountTransferUpdates(slot.operatorWallet.address, slot.accountIndex, {
      limit: 50,
      from: toMicros(since),
    });
    const match = updates.find((update) => update.type === "WITHDRAWAL" && update.id === withdrawalId);
    if (match?.status === "APPLIED") return toBaseUnits(match.amount, decimals);
    if (match && match.status.startsWith("REJECTED")) {
      throw new Error(`Withdrawal ${withdrawalId} rejected: ${match.rejectReason ?? match.status}`);
    }
    await sleep(config.depositPollIntervalMs);
  }

  throw new Error(`Withdrawal ${withdrawalId} not applied within ${Math.round(timeoutMs / 1000)}s`);
}

export { dollarsToQuantums };
