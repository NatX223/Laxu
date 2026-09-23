import { getAccount, submitInternalTransfer } from "../arcus/client";
import { signTransfer } from "../arcus/eip712";
import { QUOTE_QUANTUMS_PER_DOLLAR } from "../arcus/types";
import { compareDecimal, parseDecimal } from "../lib/decimal";
import { createLogger } from "../lib/logger";
import { operatorEvmKey, type SlotWithWallet } from "./allocator";
import { unixNanos } from "../arcus/signing";

const log = createLogger("sweep");

/// A human dollar string as Arcus quote quantums (1e9 = $1), truncated.
export function dollarsToQuantums(dollars: string): bigint {
  const value = parseDecimal(dollars);
  return value.scale <= 9
    ? (value.units * QUOTE_QUANTUMS_PER_DOLLAR) / 10n ** BigInt(value.scale)
    : value.units / 10n ** BigInt(value.scale - 9);
}

/**
 * Move whatever collateral is left on a subaccount back to index 0 before the
 * slot is recycled.
 *
 * Without this, the next user to be handed the slot would inherit a non-zero
 * balance -- and the deposit watcher, which compares against the account's own
 * transfer feed, would be working against someone else's money.
 *
 * Note this call is the one Arcus write that is *not* Ed25519-signed: the
 * gateway authenticates a transfer from a secp256k1 EIP-712 signature in the
 * body, so it uses the operator wallet's EVM key rather than the slot's API key.
 */
export async function sweepSubaccount(slot: SlotWithWallet): Promise<{ swept: string } | null> {
  if (slot.accountIndex === 0) {
    // Index 0 is the sweep destination; there is nowhere to move it to.
    return null;
  }

  const account = await getAccount(slot.operatorWallet.address, slot.accountIndex);
  if (!account) return null;

  // Free collateral, not equity: anything still posted as margin cannot move,
  // and a position that has not fully settled yet will free up on the next pass.
  const free = account.freeCollateral ?? "0";
  if (compareDecimal(free, "0") <= 0) return null;

  const quantums = dollarsToQuantums(free);
  if (quantums <= 0n) return null;

  const nonce = unixNanos().toString();
  const signature = await signTransfer({
    privateKey: operatorEvmKey(slot),
    ethereumAddress: slot.operatorWallet.address,
    fromAccountIndex: slot.accountIndex,
    toAccountIndex: 0,
    amount: quantums,
    nonce,
  });

  await submitInternalTransfer({
    ethereumAddress: slot.operatorWallet.address,
    fromAccountIndex: slot.accountIndex,
    toAccountIndex: 0,
    amount: quantums.toString(),
    nonce,
    signature,
  });

  log.info("subaccount swept", {
    slotId: slot.id,
    accountIndex: slot.accountIndex,
    amount: free,
  });

  return { swept: free };
}
