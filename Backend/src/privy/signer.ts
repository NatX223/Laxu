import { APIError } from "@privy-io/node";
import type { Address, Hash, Hex } from "viem";

import { privy } from "../auth/privy";
import { config } from "../config/env";
import { normalizeAuthKey } from "./authKey";

/**
 * How the backend sends a transaction FROM a user's Privy wallet. Everything in
 * loan protection goes through this interface, so the transport can change
 * without touching the worker.
 *
 * The spike (docs/privy-findings.md, 1.1) found Privy both signs and broadcasts
 * on Monad testnet, so the one implementation is `sendTransaction`. Had it only
 * signed, a second implementation (signTransaction + viem sendRawTransaction)
 * would sit behind the same interface.
 */

export interface SendTxRequest {
  to: Address;
  data: Hex;
  value?: bigint;
  /// Explicit gas limit. Monad bills the LIMIT, so pass the estimate plus a small buffer, never a large constant.
  gas?: bigint;
  chainId: number;
}

export interface PrivyWalletSender {
  sendTx(walletId: string, tx: SendTxRequest): Promise<{ hash: Hash }>;
}

class PrivyBroadcastSender implements PrivyWalletSender {
  private authorization?: { authorization_private_keys: string[] };

  /// Built on first use so a missing key fails the first send, not the import.
  private context() {
    if (!this.authorization) {
      this.authorization = { authorization_private_keys: [normalizeAuthKey(config.privyAuthPrivateKey)] };
    }
    return this.authorization;
  }

  async sendTx(walletId: string, tx: SendTxRequest): Promise<{ hash: Hash }> {
    if (tx.chainId !== config.chainId) throw new Error(`refusing to send on chain ${tx.chainId}; this backend is on ${config.chainId}`);
    const transaction: Record<string, string> = { to: tx.to, data: tx.data, value: `0x${(tx.value ?? 0n).toString(16)}` };
    if (tx.gas !== undefined) transaction.gas_limit = `0x${tx.gas.toString(16)}`;

    const result = await privy()
      .wallets()
      .ethereum()
      .sendTransaction(walletId, {
        caip2: `eip155:${tx.chainId}`,
        params: { transaction },
        authorization_context: this.context(),
      } as never);
    return { hash: result.hash as Hash };
  }
}

let sender: PrivyWalletSender | undefined;

export function privyWalletSender(): PrivyWalletSender {
  sender ??= new PrivyBroadcastSender();
  return sender;
}

/// For tests and for swapping the transport.
export function setPrivyWalletSender(next: PrivyWalletSender | undefined): void {
  sender = next;
}

// ---------------------------------------------------------------------------
// What a Privy error means for a rule
// ---------------------------------------------------------------------------

export type PrivyFailure =
  /// 400 policy_violation: Privy's policy refused the call (should not happen for a well-formed repay).
  | "policy"
  /// 401: no valid authorization signature, which is what Privy answers once the user has removed the signer.
  | "signer-removed"
  /// 400 transaction_broadcast_failure: the call was allowed but would revert / could not be broadcast.
  | "broadcast"
  | "other";

export function classifyPrivyError(error: unknown): PrivyFailure {
  if (!(error instanceof APIError)) return "other";
  const code = (error.error as { code?: string } | undefined)?.code;
  if (error.status === 401) return "signer-removed";
  if (code === "policy_violation") return "policy";
  if (code === "transaction_broadcast_failure") return "broadcast";
  return "other";
}

/// A one-line, secret-free description for the event log.
export function describePrivyError(error: unknown): string {
  if (error instanceof APIError) {
    const body = error.error as { error?: string; code?: string } | undefined;
    return `Privy ${error.status}${body?.code ? ` ${body.code}` : ""}: ${body?.error ?? "request failed"}`.slice(0, 300);
  }
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
