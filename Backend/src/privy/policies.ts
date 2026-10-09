import { getAddress } from "viem";

import { privy } from "../auth/privy";
import { config } from "../config/env";
import { normalizeAuthKey } from "./authKey";

/**
 * The Privy policy behind one loan-protection rule (Spec 05 2.4).
 *
 * One ALLOW rule on eth_sendTransaction and nothing else. Measured in the spike
 * (docs/privy-findings.md, 1.2): a request matching no rule is denied, and a
 * DENY-all rule would override the ALLOW whatever the order -- so there is
 * deliberately no DENY rule here. `approve`, `transfer` and every other method
 * are therefore refused by Privy. The user grants the ERC-20 allowance
 * themselves, in their own transaction.
 *
 * A signer must never outlive its policy, so policies are not deleted when a
 * rule is turned off (deleting one while still attached could leave the signer
 * without its restriction). They are inert once the signer is removed.
 */

const repayAbi = [
  {
    name: "repay",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ name: "repaid", type: "uint256" }],
  },
] as const;

export interface RepayPolicyInput {
  /// The lending pool the signer may call.
  pool: string;
  /// Largest `amount` one repay may carry, in the debt asset's base units.
  maxPerCall: bigint;
  chainId: number;
}

export interface RepayPolicyBody {
  name: string;
  version: "1.0";
  chain_type: "ethereum";
  rules: Array<{
    name: string;
    method: "eth_sendTransaction";
    action: "ALLOW";
    conditions: Array<Record<string, unknown>>;
  }>;
  owner_id: string;
}

/// The exact request body sent to `policies().create`. Pure, so it is unit-tested and shown in the docs.
export function buildRepayPolicy(input: RepayPolicyInput, ownerId: string): RepayPolicyBody {
  const pool = getAddress(input.pool);
  return {
    name: `laxu-repay-${pool.slice(0, 10)}`,
    version: "1.0",
    chain_type: "ethereum",
    rules: [
      {
        name: "allow repay(amount <= maxPerCall) on this pool only",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_transaction", field: "to", operator: "eq", value: pool },
          { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: String(input.chainId) },
          { field_source: "ethereum_transaction", field: "value", operator: "lte", value: "0x0" },
          { field_source: "ethereum_calldata", field: "function_name", abi: repayAbi, operator: "eq", value: "repay" },
          {
            field_source: "ethereum_calldata",
            field: "repay.amount",
            abi: repayAbi,
            operator: "lte",
            value: `0x${input.maxPerCall.toString(16)}`,
          },
        ],
      },
    ],
    owner_id: ownerId,
  };
}

/// Deletes a policy this server owns. Callers must first be sure no signer on any wallet still holds it.
export async function deletePolicy(policyId: string): Promise<void> {
  await privy()
    .policies()
    .delete(policyId, { authorization_context: { authorization_private_keys: [normalizeAuthKey(config.privyAuthPrivateKey)] } } as never);
}

/// Creates the policy in Privy (owned by the server's key quorum) and returns its id.
export async function createRepayPolicy(input: RepayPolicyInput): Promise<string> {
  if (!config.privySignerId) throw new Error("PRIVY_SIGNER_ID is not set");
  const body = buildRepayPolicy(input, config.privySignerId);
  const policy = await privy().policies().create(body as never);
  return policy.id;
}
