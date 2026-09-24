import type { Address, Hash, WalletClient } from "viem";

import { getAccountTransferUpdates } from "../arcus/client";
import type { AccountTransferUpdate } from "../arcus/types";
import { internalWallet } from "../chain/clients";
import {
  ensureDepositProxyApproval,
  initiateArcusDeposit,
  mintUsdg,
  usdgBalanceOf,
} from "../chain/writes";
import { db } from "../config/db";
import { config } from "../config/env";
import { createLogger } from "../lib/logger";
import { toUsdg6 } from "../lib/units";
import { operatorEvmKey, type SlotWithWallet } from "./allocator";
import { getArcusStream } from "./arcusStream";

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
 * Wait for Arcus to credit a deposit to this exact subaccount, usually within a
 * minute. The shared stream's DEPOSIT event is the main signal, with a REST
 * poll alongside. `since` bounds the search to deposits made for this request:
 * the slot was exclusively ours from then on, so any credit after it is ours.
 * Returns the credited amount in USDG base units.
 */
export async function waitForCredit(
  slot: SlotWithWallet,
  since: Date,
  timeoutMs = config.arcusCreditTimeoutMs,
): Promise<{ transferId: string; credited: bigint }> {
  const credit = await getArcusStream().awaitTransfer({
    address: slot.operatorWallet.address,
    accountIndex: slot.accountIndex,
    type: "DEPOSIT",
    since,
    // Spot-asset deposits carry a size in the asset's own units, not USD.
    match: (update) => !(update.spotAssetId && update.spotAssetId > 0),
    timeoutMs,
    label: `deposit credit on ${slot.operatorWallet.address} index ${slot.accountIndex}`,
  });
  if (credit.status?.startsWith("REJECTED")) {
    throw new Error(`Arcus rejected the deposit on index ${slot.accountIndex}: ${credit.rejectReason ?? credit.status}`);
  }
  return { transferId: credit.id, credited: toUsdg6(credit.amount) };
}

/**
 * Creators' payments that sit on an internal wallet before their deposit goes
 * out. Never spendable on anything else -- a refund, a buy-in's funding or a
 * redeem payout must come out of what is left over.
 */
export async function heldForOpenRequests(walletAddress: string, exceptOpenRequestId?: string): Promise<bigint> {
  const slotIds = (
    await db.subaccountSlot.findMany({
      where: { operatorWallet: { address: { equals: walletAddress, mode: "insensitive" } } },
      select: { id: true },
    })
  ).map((row) => row.id);
  const held = await db.positionOpenRequest.findMany({
    where: {
      ...(exceptOpenRequestId ? { id: { not: exceptOpenRequestId } } : {}),
      status: "payment_received",
      arcusDepositTxHash: null,
      slotId: { in: slotIds },
    },
    select: { amount: true },
  });
  return held.reduce((sum, row) => sum + BigInt(row.amount), 0n);
}

/**
 * Make sure the slot's internal wallet has `amount` USDG it may spend (on top
 * of creators' held payments). Testnet (USDG_MINTABLE): mints the shortfall.
 * Mainnet: the float must already cover it, or this throws and the caller's
 * retry picks it up once the float is refilled.
 */
export async function ensureInternalWalletFloat(slot: SlotWithWallet, amount: bigint): Promise<void> {
  const walletAddress = slot.operatorWallet.address as Address;
  const [balance, held] = await Promise.all([usdgBalanceOf(walletAddress), heldForOpenRequests(walletAddress)]);
  const spare = balance > held ? balance - held : 0n;
  if (spare >= amount) return;
  const shortfall = amount - spare;
  if (!config.usdgMintable) {
    throw new Error(`Internal wallet ${walletAddress} float is short ${shortfall} USDG base units`);
  }
  await mintUsdg(walletForSlot(slot), walletAddress, shortfall);
  log.info("internal wallet float topped up by mint", { wallet: walletAddress, amount: shortfall.toString() });
}

/**
 * Fund a subaccount for a buy-in. The buyer's USDG stays inside the
 * PositionToken as the payout buffer for later redeems, so the Arcus side is
 * funded from the slot's internal wallet: minted on testnet, the float on
 * mainnet. Then `initiateDeposit(owner = itself, accountIndex = slot)` and
 * wait for the DEPOSIT credit on the shared stream.
 */
export async function fundSubaccount(slot: SlotWithWallet, amount: bigint): Promise<{ credited: bigint }> {
  await ensureInternalWalletFloat(slot, amount);
  const since = new Date();
  await depositToSubaccount(slot, amount);
  const { credited } = await waitForCredit(slot, since);
  return { credited };
}
