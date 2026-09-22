import { privateKeyToAccount } from "viem/accounts";

import { getAccount, submitInternalTransfer } from "../arcus/client";
import { QUOTE_QUANTUMS_PER_DOLLAR } from "../arcus/types";
import { config } from "../config/env";
import { compareDecimal, parseDecimal } from "../lib/decimal";
import { createLogger } from "../lib/logger";
import { operatorEvmKey, type SlotWithWallet } from "./allocator";
import { unixNanos } from "../arcus/signing";

const log = createLogger("sweep");

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

  const dollars = parseDecimal(free);
  const quantums =
    dollars.scale <= 9
      ? dollars.units * QUOTE_QUANTUMS_PER_DOLLAR / 10n ** BigInt(dollars.scale)
      : dollars.units / 10n ** BigInt(dollars.scale - 9);

  if (quantums <= 0n) return null;

  const signature = await signTransfer({
    privateKey: operatorEvmKey(slot),
    ethereumAddress: slot.operatorWallet.address,
    fromAccountIndex: slot.accountIndex,
    toAccountIndex: 0,
    amount: quantums,
    nonce: unixNanos().toString(),
  });

  await submitInternalTransfer({
    ethereumAddress: slot.operatorWallet.address,
    fromAccountIndex: slot.accountIndex,
    toAccountIndex: 0,
    amount: quantums.toString(),
    nonce: signature.nonce,
    signature: signature.rsv,
  });

  log.info("subaccount swept", {
    slotId: slot.id,
    accountIndex: slot.accountIndex,
    amount: free,
  });

  return { swept: free };
}

async function signTransfer(params: {
  privateKey: string;
  ethereumAddress: string;
  fromAccountIndex: number;
  toAccountIndex: number;
  amount: bigint;
  nonce: string;
}): Promise<{ nonce: string; rsv: { r: string; s: string; v: string } }> {
  if (!config.arcusBridgeVault || !config.arcusRootChainId) {
    throw new Error(
      "Sweeping needs ARCUS_BRIDGE_VAULT and ARCUS_ROOT_CHAIN_ID (the EIP-712 domain for /v1/transfer)",
    );
  }

  const key = params.privateKey.startsWith("0x") ? params.privateKey : `0x${params.privateKey}`;
  const account = privateKeyToAccount(key as `0x${string}`);

  const signature = await account.signTypedData({
    domain: {
      name: "Arcus Transfer",
      version: "1",
      chainId: config.arcusRootChainId,
      verifyingContract: config.arcusBridgeVault as `0x${string}`,
    },
    types: {
      Transfer: [
        { name: "ethereumAddress", type: "address" },
        { name: "fromAccountIndex", type: "uint8" },
        { name: "toAccountIndex", type: "uint8" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "string" },
      ],
    },
    primaryType: "Transfer",
    message: {
      ethereumAddress: params.ethereumAddress as `0x${string}`,
      fromAccountIndex: params.fromAccountIndex,
      toAccountIndex: params.toAccountIndex,
      amount: params.amount,
      nonce: params.nonce,
    },
  });

  return {
    nonce: params.nonce,
    rsv: {
      r: signature.slice(0, 66),
      s: `0x${signature.slice(66, 130)}`,
      v: `0x${signature.slice(130, 132)}`,
    },
  };
}
