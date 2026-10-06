import type { Settlement } from "@prisma/client";
import type { Address, Hash } from "viem";

import { floatAddress } from "../chain/clients";
import {
  assetBalanceOf,
  assetTransfersIn,
  claimFor,
  isClosed,
  isContract,
  pendingRedeem,
  readSettlement,
  receiptStatus,
  recoverExcess,
  settle,
  shareBalanceOf,
  totalPendingDepositAssets,
  transferAsset,
} from "../chain/writes";
import { db } from "../config/db";
import { alert, createLogger, errorFields } from "../lib/logger";
import { fromAsset6 } from "../lib/units";
import { venue } from "../venue/types";
import { getSlotForPosition, releaseSlot, slotWallet, type SlotWithWallet } from "./allocator";
import { ensureSlotFloat, withSlotLock } from "./float";
import { marketForPosition } from "./markets";
import { sweepSlot } from "./sweep";

const log = createLogger("settlement");

/**
 * Settlement: after `close()`, bring the position's asset back from the venue
 * into the PositionToken and let every holder claim their share.
 *
 *   1. the venue position is flat (on-chain read)
 *   2. slot -> 'settling'
 *   3. withdraw everything above the slot's reserve to the slot wallet
 *      (`withdrawCollateral`, synchronous: it lands in the same transaction)
 *   4. recovered = what that withdrawal paid out (0 is valid: a wiped liquidation)
 *   5. top the token up so its buffer (balance - pending buy-ins) covers it
 *   6. token.settle(recovered)
 *   7. token.recoverExcess(float) -- the float fronted for buy-ins
 *   8. slot swept + freed; position 'settled'
 *   9. push claims to every EOA holder
 *
 * Holders share what was actually recovered, never the contract's formula
 * estimate: a liquidation's leftover after the venue's penalty is often below it.
 *
 * Crash safety: every step records itself on the `settlements` row and checks
 * the chain before acting (`settled()` before settle, the token's balance
 * before topping it up, a saved withdrawal hash's receipt before sending
 * another), so the resume job can rerun this from the top at any point.
 */

/// The venue is not flat yet, or a withdrawal was refused (the exchange's
/// rate limit, a halt). The resume job retries after its back-off.
export class SettlementRetryLater extends Error {}

export async function settlementFor(positionId: string): Promise<Settlement | null> {
  return db.settlement.findUnique({ where: { positionId } });
}

async function updateSettlement(positionId: string, data: Partial<Omit<Settlement, "positionId">>): Promise<Settlement> {
  return db.settlement.update({ where: { positionId }, data });
}

/// Runs the whole settlement for a position whose `close()` has landed.
/// Callers serialise per position (see closePosition.ts).
export async function runSettlement(positionId: string): Promise<void> {
  const position = await db.position.findUnique({ where: { id: positionId } });
  if (!position?.positionTokenAddress) throw new Error(`Position ${positionId} has no token address`);
  const token = position.positionTokenAddress as Address;

  let row = await settlementFor(positionId);
  if (!row) {
    row = await db.settlement.create({
      data: { positionId, trigger: position.liquidated ? "liquidation" : "creator_close" },
    });
  }

  try {
    const onChain = await readSettlement(token);
    const slot = await getSlotForPosition(positionId);

    if (!onChain.settled) {
      if (!(await isClosed(token))) throw new Error(`Position ${positionId} is not closed on-chain yet`);
      if (!slot) throw new Error(`Position ${positionId} is closed but has no slot to settle from`);

      await assertFlat(slot, position.market);
      if (slot.status !== "settling") {
        await db.subaccountSlot.update({ where: { id: slot.id }, data: { status: "settling" } });
      }

      const recovered = await recoverFromVenue(row, slot);
      row = await updateSettlement(positionId, { status: "settling", recoveredAssets: recovered.toString(), error: null });

      await fundToken(row, slot, token, recovered);

      // Re-read: a settle that landed before a crash must not be sent twice.
      if (!(await readSettlement(token)).settled) {
        const txHash = await settle(token, recovered);
        row = await updateSettlement(positionId, { settleTxHash: txHash });
        log.info("position settled on-chain", { positionId, recovered: fromAsset6(recovered), txHash });
      }
    }

    // --- 7. Return the float --------------------------------------------
    if (slot) await returnFloat(row, token);

    // --- 8. Recycle the slot, mark settled ------------------------------
    if (slot) {
      try {
        await sweepSlot(slot);
        await releaseSlot(slot.id);
      } catch (error) {
        // Settled either way; a slot recycled with money on it would hand that
        // balance to the next user, so it stays 'settling' for the next pass.
        log.error("sweep after settlement failed; slot held back", { positionId, slotId: slot.id, ...errorFields(error) });
      }
    }
    await db.position.update({
      where: { id: positionId },
      data: { status: "settled", closedAt: position.closedAt ?? new Date() },
    });
    row = await updateSettlement(positionId, { status: "settled", error: null });

    // A redeem the close overtook can never be fulfilled now: it is paid by
    // claim. (A pending buy-in stays pending until its buyer cancels -- the
    // refund is theirs to take, immediately once closed.)
    await db.ledgerEntry.updateMany({
      where: {
        positionId,
        type: "margin_remove",
        onchainFulfilledAt: null,
        venueStatus: { in: ["pending", "confirmed"] },
      },
      data: { venueStatus: "cancelled", note: "position closed before fulfil; paid via claim" },
    });
  } catch (error) {
    await updateSettlement(positionId, { error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
    throw error;
  }

  // --- 9. Push claims -------------------------------------------------------
  if (!row.claimsPushedAt) await pushClaims(positionId);
}

/// Step 1: the venue position must be gone before its margin can come out in full.
async function assertFlat(slot: SlotWithWallet, marketKey: string): Promise<void> {
  const market = await marketForPosition(marketKey);
  const leg = await venue().getPosition(slot, market);
  if (leg.exists) {
    throw new SettlementRetryLater(`venue position on slot ${slot.id} is not flat yet (size6 ${leg.size6})`);
  }
}

/// What a withdrawal transaction paid the slot wallet, from its asset Transfer log.
async function paidToWallet(txHash: Hash, wallet: Address): Promise<bigint | null> {
  const { status, transfers } = await assetTransfersIn(txHash);
  if (status !== "success") return null;
  return transfers
    .filter((transfer) => transfer.to.toLowerCase() === wallet.toLowerCase())
    .reduce((sum, transfer) => sum + transfer.value, 0n);
}

/// What a settlement recovers: the account's free balance above the slot's
/// reserve, never negative (a wiped-out position recovers 0).
export function recoverableAboveReserve(free: bigint, reserve: bigint): bigint {
  return free > reserve ? free - reserve : 0n;
}

/**
 * Steps 3-4. Returns the asset (6dp) recovered onto the slot wallet.
 *
 *   - a saved `withdrawTxHash`: its receipt decides (success -> the amount its
 *     Transfer log paid the wallet; reverted -> forget it and retry later);
 *   - `withdrawStartedAt` without a hash (the process died between sending and
 *     saving): an account already at its reserve means it went out -- the
 *     wallet's balance is what arrived (one slot = one position, so nothing
 *     else is on it);
 *   - nothing above the reserve: holders share 0;
 *   - otherwise mark `withdrawStartedAt`, withdraw, save the hash the moment
 *     it is broadcast.
 */
async function recoverFromVenue(row: Settlement, slot: SlotWithWallet): Promise<bigint> {
  if (row.recoveredAssets !== null) return BigInt(row.recoveredAssets);
  const positionId = row.positionId;
  const wallet = slot.operatorWallet.address as Address;

  if (row.withdrawTxHash) {
    const status = await receiptStatus(row.withdrawTxHash as Hash);
    if (status === "unknown") throw new SettlementRetryLater(`withdrawal ${row.withdrawTxHash} not confirmed yet`);
    if (status === "success") {
      const paid = await paidToWallet(row.withdrawTxHash as Hash, wallet);
      return paid ?? 0n;
    }
    await updateSettlement(positionId, { withdrawTxHash: null, withdrawStartedAt: null });
    throw new SettlementRetryLater(`withdrawal ${row.withdrawTxHash} reverted; will retry`);
  }

  return withSlotLock(slot.id, async () => {
    const reserve = BigInt(slot.reserve);
    const free = await venue().accountBalance(slot);
    const recovered = recoverableAboveReserve(free, reserve);

    if (recovered === 0n) {
      if (row.withdrawStartedAt) {
        const held = await assetBalanceOf(wallet);
        log.warn("withdrawal went out before its hash was saved; using the wallet balance", { positionId, held: fromAsset6(held) });
        return held;
      }
      log.warn("nothing above the reserve at settlement; holders share 0", { positionId, free: fromAsset6(free) });
      return 0n;
    }

    // Marked started BEFORE sending: see the doc above.
    await updateSettlement(positionId, { status: "withdrawing", withdrawStartedAt: new Date() });
    let txHash: Hash;
    try {
      txHash = await venue().withdraw(slot, recovered, {
        onSent: async (hash) => {
          await updateSettlement(positionId, { withdrawTxHash: hash });
        },
      });
    } catch (error) {
      const saved = (await settlementFor(positionId))?.withdrawTxHash;
      if (saved) throw new SettlementRetryLater(`withdrawal ${saved} not confirmed: ${String(error)}`);
      // Never broadcast or reverted (rate limit, halt): nothing moved.
      await updateSettlement(positionId, { withdrawStartedAt: null, withdrawTxHash: null });
      throw new SettlementRetryLater(`settlement withdrawal refused: ${error instanceof Error ? error.message : String(error)}`);
    }
    const paid = await paidToWallet(txHash, wallet);
    log.info("settlement withdrawal landed", { positionId, amount: fromAsset6(paid ?? recovered), txHash });
    return paid ?? recovered;
  });
}

/**
 * Step 5. The token already holds buy-in asset as a buffer; only the part of
 * `recovered` it cannot cover is sent in. Recomputed from on-chain balances
 * every time, so a transfer that landed before a crash is never repeated.
 */
async function fundToken(row: Settlement, slot: SlotWithWallet, token: Address, recovered: bigint): Promise<void> {
  const [balance, pending] = await Promise.all([assetBalanceOf(token), totalPendingDepositAssets(token)]);
  const buffer = balance > pending ? balance - pending : 0n;
  if (recovered <= buffer) return;

  const shortfall = recovered - buffer;
  await ensureSlotFloat(slot, shortfall);
  const txHash = await transferAsset(slotWallet(slot), token, shortfall);
  await updateSettlement(row.positionId, { fundTxHash: txHash });
  log.info("settlement funded from the slot wallet", { positionId: row.positionId, amount: fromAsset6(shortfall), txHash });
}

/// Step 7. Anything beyond unclaimed payouts and pending buy-in refunds is the
/// float the backend fronted on the venue for buy-ins -- back to the float.
async function returnFloat(row: Settlement, token: Address): Promise<void> {
  const [state, balance, pending] = await Promise.all([
    readSettlement(token),
    assetBalanceOf(token),
    totalPendingDepositAssets(token),
  ]);
  const owed = state.settlementAssets - state.claimedAssets + pending;
  if (balance <= owed) return;

  const txHash = await recoverExcess(token, floatAddress());
  await updateSettlement(row.positionId, { recoverTxHash: txHash });
  log.info("float recovered from settled token", { positionId: row.positionId, amount: fromAsset6(balance - owed), txHash });
}

/**
 * Step 9. `claimFor` every holder -- wallet balance or a redeem caught pending
 * at close -- so nobody has to come back and press a button. The operator pays
 * the gas. Contracts are skipped (claimFor rejects them): a LendingPool's
 * collateral is claimed by its borrower after repaying and withdrawing.
 *
 * `claim()` stays open to everyone as the fallback, so a failure here is
 * logged, not fatal; `claimsPushedAt` is only set once a pass has no failures.
 */
export async function pushClaims(positionId: string): Promise<void> {
  const position = await db.position.findUnique({ where: { id: positionId } });
  if (!position?.positionTokenAddress) return;
  const token = position.positionTokenAddress as Address;

  const [holdings, redeemers] = await Promise.all([
    db.holding.findMany({ where: { positionId }, select: { address: true } }),
    db.ledgerEntry.findMany({
      where: { positionId, type: "margin_remove", controller: { not: null } },
      select: { controller: true },
    }),
  ]);
  // The creator is always a candidate: their genesis mint can race the DB row
  // the indexer needs (seen on testnet 2026-10-06 -- the PositionCreated
  // catch-up ran before the mint's bookkeeping, the mint Transfer was dropped,
  // and a pass with no holdings "pushed" nothing). The chain decides below.
  const candidates = new Set<string>([
    position.userWalletAddress.toLowerCase(),
    ...holdings.map((h) => h.address.toLowerCase()),
    ...redeemers.map((r) => (r.controller as string).toLowerCase()),
  ]);

  let failures = 0;
  let paid = 0;
  for (const address of candidates) {
    const holder = address as Address;
    try {
      // The DB can lag the chain; the chain decides who still has a claim.
      const [held, redeeming] = await Promise.all([shareBalanceOf(token, holder), pendingRedeem(token, holder)]);
      if (held + redeeming === 0n) continue;
      if (await isContract(holder)) continue;
      const txHash = await claimFor(token, holder);
      paid += 1;
      log.info("claim pushed", { positionId, holder, txHash });
    } catch (error) {
      failures += 1;
      log.error("claim push failed; the holder can still claim() themselves", { positionId, holder, ...errorFields(error) });
    }
  }

  if (failures === 0) {
    await updateSettlement(positionId, { claimsPushedAt: new Date() });
  } else {
    alert("some settlement claims were not pushed", { positionId, failures, paid });
  }
}
