import type { Address } from "viem";

import { getAccount, submitWithdrawal } from "../arcus/client";
import { signWithdraw } from "../arcus/eip712";
import { unixNanos } from "../arcus/signing";
import type { AccountTransferUpdate } from "../arcus/types";
import { usdgBalanceOf } from "../chain/writes";
import { config } from "../config/env";
import { sleep } from "../lib/async";
import { createLogger } from "../lib/logger";
import { fromUsdg6, toUsdg6, usdg6ToArcusQuantums } from "../lib/units";
import { credentialsFor, operatorEvmKey, type SlotWithWallet } from "./allocator";
import { getArcusStream } from "./arcusStream";

const log = createLogger("arcus-withdraw");

/**
 * Arcus withdrawals -- always withdraw-to-self, so the USDG lands on the slot's
 * internal wallet on Robinhood Chain testnet (the chain deposits use too); the
 * backend moves it on from there.
 *
 * Used by refunds after an unfilled open order, float recycling after redeems,
 * and the close-out sweep.
 *
 * POST /v1/withdraw is weight 125 and shares the heavyweight queue in
 * arcus/client.ts with setLeverage and transfer (~12/minute per IP).
 */

/// Arcus rejects withdrawals under $1.
export const MIN_WITHDRAWAL_USDG6 = 1_000_000n;

export class WithdrawalRejectedError extends Error {
  constructor(
    readonly withdrawalId: string | undefined,
    readonly reason: string,
  ) {
    super(`Withdrawal ${withdrawalId ?? "(unknown id)"} rejected: ${reason}`);
  }
}

export interface WithdrawalHandle {
  /// Absent only when Arcus answered 409 without echoing the id (a retried
  /// nonce) -- then correlated by amount and time.
  withdrawalId?: string;
  /// What was actually requested, USDG 6dp: min(needed, withdrawable).
  amount6: bigint;
  submittedAt: Date;
}

/// USDG that can leave the subaccount now. Margin still posted to an open
/// position is not withdrawable.
export async function withdrawable6(slot: SlotWithWallet): Promise<bigint> {
  const account = await getAccount(slot.operatorWallet.address, slot.accountIndex);
  if (!account) return 0n;
  const free = toUsdg6(account.freeCollateral ?? "0");
  return free > 0n ? free : 0n;
}

/**
 * Withdraw `min(usdg6, withdrawable)` to the slot's internal wallet. Throws if
 * that is under Arcus's $1 minimum. Returns as soon as Arcus queues it -- see
 * {awaitWithdrawalApplied} and {awaitUsdgArrival}.
 */
export async function withdrawToInternalWallet(slot: SlotWithWallet, usdg6: bigint): Promise<WithdrawalHandle> {
  const free = await withdrawable6(slot);
  const amount6 = usdg6 < free ? usdg6 : free;
  if (amount6 < MIN_WITHDRAWAL_USDG6) {
    throw new Error(
      `Nothing to withdraw on index ${slot.accountIndex}: ${fromUsdg6(amount6)} USDG withdrawable (min $1, wanted ${fromUsdg6(usdg6)})`,
    );
  }

  const quantums = usdg6ToArcusQuantums(amount6);
  // Unique per (address, accountIndex): a nanosecond timestamp.
  const nonce = unixNanos().toString();
  const submittedAt = new Date();

  const result =
    config.arcusWithdrawSigning === "apikey"
      ? await submitWithdrawal({
          ethereumAddress: slot.operatorWallet.address,
          accountIndex: slot.accountIndex,
          amount: quantums.toString(),
          nonce,
          credentials: credentialsFor(slot),
        })
      : await submitWithdrawal({
          ethereumAddress: slot.operatorWallet.address,
          accountIndex: slot.accountIndex,
          amount: quantums.toString(),
          nonce,
          signature: await signWithdraw({
            privateKey: operatorEvmKey(slot),
            ethereumAddress: slot.operatorWallet.address,
            accountIndex: slot.accountIndex,
            amount: quantums,
            nonce,
          }),
        });

  log.info("withdrawal submitted", {
    slotId: slot.id,
    accountIndex: slot.accountIndex,
    amount: fromUsdg6(amount6),
    withdrawalId: result.withdrawalId,
    duplicate: result.duplicate,
    mode: config.arcusWithdrawSigning,
  });
  return { withdrawalId: result.withdrawalId, amount6, submittedAt };
}

/// Correlate on the id; fall back to type + amount when the event carries no
/// id we recognise (the stream's example shows only an `eventId`).
export function matchesWithdrawal(update: AccountTransferUpdate, withdrawalId?: string, amount6?: bigint): boolean {
  if (update.type !== "WITHDRAWAL") return false;
  if (withdrawalId && (update.id === withdrawalId || update.withdrawalId === withdrawalId || update.eventId === withdrawalId)) {
    return true;
  }
  const carriesId = Boolean(update.withdrawalId);
  if (withdrawalId && carriesId) return false; // a different withdrawal's id
  return amount6 !== undefined && toUsdg6(update.amount) === amount6;
}

/**
 * Wait for the withdrawal's WITHDRAWAL event (stream first, REST every 15s).
 * Returns the applied amount in USDG 6dp; throws {WithdrawalRejectedError} on
 * REJECTED_ACCOUNT_IN_WIND_DOWN, REJECTED_INSUFFICIENT_COLLATERAL, etc.
 */
export async function awaitWithdrawalApplied(
  slot: SlotWithWallet,
  withdrawalId: string | undefined,
  options: { since: Date; amount6?: bigint; timeoutMs?: number },
): Promise<bigint> {
  const update = await getArcusStream().awaitTransfer({
    address: slot.operatorWallet.address,
    accountIndex: slot.accountIndex,
    type: "WITHDRAWAL",
    since: options.since,
    match: (row) => matchesWithdrawal(row, withdrawalId, options.amount6),
    timeoutMs: options.timeoutMs ?? config.withdrawalAppliedTimeoutMs,
    label: `withdrawal ${withdrawalId ?? fromUsdg6(options.amount6 ?? 0n)} on index ${slot.accountIndex}`,
  });
  if (update.status?.startsWith("REJECTED")) {
    throw new WithdrawalRejectedError(withdrawalId, update.rejectReason ?? update.status);
  }
  return toUsdg6(update.amount);
}

/// Wait until `wallet` holds at least `minBalance6` USDG on-chain.
export async function awaitUsdgArrival(
  wallet: Address,
  minBalance6: bigint,
  timeoutMs = config.usdgArrivalTimeoutMs,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await usdgBalanceOf(wallet)) >= minBalance6) return;
    await sleep(config.depositPollIntervalMs * 2);
  }
  throw new Error(`USDG balance of ${wallet} did not reach ${fromUsdg6(minBalance6)} within ${Math.round(timeoutMs / 1000)}s`);
}
