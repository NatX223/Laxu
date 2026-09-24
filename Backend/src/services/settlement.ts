import type { Settlement } from "@prisma/client";
import type { Address } from "viem";

import { getPositions } from "../arcus/client";
import {
  claimFor,
  isClosed,
  isContract,
  pendingRedeem,
  readSettlement,
  recoverExcess,
  settle,
  shareBalanceOf,
  totalPendingDepositAssets,
  transferUsdg,
  usdgBalanceOf,
} from "../chain/writes";
import { db } from "../config/db";
import { isZeroDecimal } from "../lib/decimal";
import { alert, createLogger, errorFields } from "../lib/logger";
import { fromUsdg6, toUsdg6 } from "../lib/units";
import { getSlotForPosition, releaseSlot, type SlotWithWallet } from "./allocator";
import { ensureInternalWalletFloat, heldForOpenRequests, walletForSlot } from "./arcusFunding";
import { getArcusStream } from "./arcusStream";
import {
  awaitUsdgArrival,
  awaitWithdrawalApplied,
  MIN_WITHDRAWAL_USDG6,
  WithdrawalRejectedError,
  withdrawable6,
  withdrawToInternalWallet,
} from "./arcusWithdraw";
import { requireMarket } from "./markets";
import { sweepSubaccount } from "./sweep";

const log = createLogger("settlement");

/**
 * Settlement: after `close()`, bring the position's USDG back from Arcus into
 * the PositionToken and let every holder claim their share.
 *
 *   1. the Arcus position is flat
 *   2. slot -> 'settling'
 *   3. withdraw everything withdrawable to the slot's internal wallet
 *   4. recovered = what actually arrived (0 is valid: a wiped liquidation)
 *   5. top the token up so its buffer (balance - pending buy-ins) covers it
 *   6. token.settle(recovered)
 *   7. token.recoverExcess(internal wallet) -- the float fronted for buy-ins
 *   8. slot swept + freed; position 'settled'
 *   9. push claims to every EOA holder
 *
 * Holders share what was actually recovered, never the contract's formula
 * estimate: a liquidation's leftover after Arcus's penalty is often below it.
 *
 * Crash safety: every step records itself on the `settlements` row and checks
 * the chain before acting (`settled()` before settle, the token's balance
 * before topping it up, a recorded withdrawal before submitting another), so
 * the resume job can rerun this from the top at any point.
 */

/// Arcus is still winding the liquidation down, or rejected the withdrawal for
/// some other transient reason. The resume job retries after its back-off.
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

      const recovered = await recoverFromArcus(row, slot);
      row = await updateSettlement(positionId, { status: "settling", recoveredAssets: recovered.toString(), error: null });

      await fundToken(row, slot, token, recovered);

      // Re-read: a settle that landed before a crash must not be sent twice.
      if (!(await readSettlement(token)).settled) {
        const txHash = await settle(token, recovered);
        row = await updateSettlement(positionId, { settleTxHash: txHash });
        log.info("position settled on-chain", { positionId, recovered: fromUsdg6(recovered), txHash });
      }
    }

    // --- 7. Return the float --------------------------------------------
    if (slot) await returnFloat(row, slot, token);

    // --- 8. Recycle the slot, mark settled ------------------------------
    if (slot) {
      try {
        await sweepSubaccount(slot);
        await releaseSlot(slot.id);
      } catch (error) {
        // Settled either way; a slot recycled with dust on it would hand that
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
        arcusStatus: { in: ["pending", "confirmed"] },
      },
      data: { arcusStatus: "cancelled", note: "position closed before fulfil; paid via claim" },
    });
  } catch (error) {
    await updateSettlement(positionId, { error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
    throw error;
  }

  // --- 9. Push claims -------------------------------------------------------
  if (!row.claimsPushedAt) await pushClaims(positionId);
}

/// Step 1: the leg must be gone before its margin can be withdrawn in full.
async function assertFlat(slot: SlotWithWallet, marketKey: string): Promise<void> {
  const market = await requireMarket(marketKey);
  const legs = await getPositions(slot.operatorWallet.address, slot.accountIndex);
  const leg = legs.find((entry) => entry.marketId === market.arcusMarketId);
  if (leg && !isZeroDecimal(leg.size)) {
    throw new SettlementRetryLater(`Arcus position on index ${slot.accountIndex} is not flat yet (size ${leg.size})`);
  }
}

/**
 * Steps 3-4. Returns the USDG (6dp) that landed on the internal wallet.
 *
 * A withdrawal is only ever submitted when the row records none in flight. If
 * the process died between submitting and saving the id, `withdrawStartedAt`
 * is set with no id: an empty subaccount then means it went out, so this waits
 * for it on the transfer feed rather than submitting again.
 */
export type WithdrawStep =
  /// Already recorded: use it, touch nothing.
  | { kind: "recovered"; amount6: bigint }
  /// A withdrawal with a known id is in flight: wait for it.
  | { kind: "await-recorded" }
  /// Submitted, but the process died before saving the id, and the subaccount
  /// is empty -- it went out. Wait for it on the feed; never submit again.
  | { kind: "await-unrecorded" }
  /// Nothing (or under Arcus's $1 minimum) to withdraw: holders share 0.
  | { kind: "nothing" }
  | { kind: "submit" };

/// Pure: what step 3 must do next, from the row and the subaccount's balance.
export function nextWithdrawStep(
  row: Pick<Settlement, "recoveredAssets" | "withdrawalId" | "withdrawStartedAt">,
  free6: bigint,
): WithdrawStep {
  if (row.recoveredAssets !== null) return { kind: "recovered", amount6: BigInt(row.recoveredAssets) };
  if (row.withdrawalId) return { kind: "await-recorded" };
  if (free6 < MIN_WITHDRAWAL_USDG6) return row.withdrawStartedAt ? { kind: "await-unrecorded" } : { kind: "nothing" };
  // Funds still on the subaccount: an attempt marked started never went out.
  return { kind: "submit" };
}

async function recoverFromArcus(row: Settlement, slot: SlotWithWallet): Promise<bigint> {
  if (row.recoveredAssets !== null) return BigInt(row.recoveredAssets);
  const positionId = row.positionId;
  const walletAddress = slot.operatorWallet.address as Address;

  let applied: bigint;
  try {
    const free = row.withdrawalId ? 0n : await withdrawable6(slot);
    const step = nextWithdrawStep(row, free);
    if (step.kind === "await-recorded") {
      const id = row.withdrawalId === "unknown" ? undefined : (row.withdrawalId as string);
      applied = await awaitWithdrawalApplied(slot, id, { since: row.withdrawStartedAt ?? row.createdAt });
    } else if (step.kind === "await-unrecorded") {
      applied = await awaitAnyWithdrawal(slot, row.withdrawStartedAt as Date);
    } else if (step.kind === "nothing") {
      // A fully wiped liquidation. Any dust is swept to index 0 with the slot.
      log.warn("nothing withdrawable at settlement; holders share 0", { positionId, free: fromUsdg6(free) });
      return 0n;
    } else {
      // Marked started BEFORE submitting: see "await-unrecorded".
      const startedAt = new Date();
      await updateSettlement(positionId, { status: "withdrawing", withdrawStartedAt: startedAt });
      const handle = await withdrawToInternalWallet(slot, free);
      await updateSettlement(positionId, { withdrawalId: handle.withdrawalId ?? "unknown" });
      applied = await awaitWithdrawalApplied(slot, handle.withdrawalId, {
        since: startedAt,
        amount6: handle.withdrawalId ? undefined : handle.amount6,
      });
    }
  } catch (error) {
    if (error instanceof WithdrawalRejectedError) {
      // Nothing moved -- forget the attempt so the retry submits a fresh one.
      // REJECTED_ACCOUNT_IN_WIND_DOWN is the expected case right after a
      // liquidation, while Arcus is still unwinding the account.
      await updateSettlement(positionId, { withdrawStartedAt: null, withdrawalId: null });
      throw new SettlementRetryLater(`Arcus rejected the settlement withdrawal: ${error.reason}`);
    }
    throw error;
  }

  // Other creators' payments may sit on the same wallet; wait until it holds
  // those AND this withdrawal before treating the money as here.
  await awaitUsdgArrival(walletAddress, (await heldForOpenRequests(walletAddress)) + applied);
  log.info("settlement withdrawal arrived", { positionId, amount: fromUsdg6(applied) });
  return applied;
}

async function awaitAnyWithdrawal(slot: SlotWithWallet, since: Date): Promise<bigint> {
  const update = await getArcusStream().awaitTransfer({
    address: slot.operatorWallet.address,
    accountIndex: slot.accountIndex,
    type: "WITHDRAWAL",
    since,
    timeoutMs: 10 * 60_000,
    label: `settlement withdrawal on index ${slot.accountIndex}`,
  });
  if (update.status?.startsWith("REJECTED")) {
    throw new WithdrawalRejectedError(update.id, update.rejectReason ?? update.status);
  }
  return toUsdg6(update.amount);
}

/**
 * Step 5. The token already holds buy-in USDG as a buffer; only the part of
 * `recovered` it cannot cover is sent in. Recomputed from on-chain balances
 * every time, so a transfer that landed before a crash is never repeated.
 */
async function fundToken(row: Settlement, slot: SlotWithWallet, token: Address, recovered: bigint): Promise<void> {
  const [balance, pending] = await Promise.all([usdgBalanceOf(token), totalPendingDepositAssets(token)]);
  const buffer = balance > pending ? balance - pending : 0n;
  if (recovered <= buffer) return;

  const shortfall = recovered - buffer;
  await ensureInternalWalletFloat(slot, shortfall);
  const txHash = await transferUsdg(walletForSlot(slot), token, shortfall);
  await updateSettlement(row.positionId, { fundTxHash: txHash });
  log.info("settlement funded from the internal wallet", { positionId: row.positionId, amount: fromUsdg6(shortfall), txHash });
}

/// Step 7. Anything beyond unclaimed payouts and pending buy-in refunds is the
/// float the backend fronted on Arcus for buy-ins.
async function returnFloat(row: Settlement, slot: SlotWithWallet, token: Address): Promise<void> {
  const [state, balance, pending] = await Promise.all([
    readSettlement(token),
    usdgBalanceOf(token),
    totalPendingDepositAssets(token),
  ]);
  const owed = state.settlementAssets - state.claimedAssets + pending;
  if (balance <= owed) return;

  const txHash = await recoverExcess(token, slot.operatorWallet.address as Address);
  await updateSettlement(row.positionId, { recoverTxHash: txHash });
  log.info("float recovered from settled token", { positionId: row.positionId, amount: fromUsdg6(balance - owed), txHash });
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
  const candidates = new Set<string>([
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
