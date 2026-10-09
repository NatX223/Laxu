/**
 * Spec 05 spike 1.2: do Privy policies reject what they should?
 *
 *   npx ts-node --transpile-only scripts/privy/02-policy.ts [--order-test]
 *
 * Needs the server wallet from 01-server-wallet.ts, plus PRIVY_SIGNER_ID and
 * PRIVY_AUTH_PRIVATE_KEY (the wallet owner must sign the policy attach).
 *
 * Policy P1 (single ALLOW rule, no DENY-all, to learn the default):
 *   eth_sendTransaction  to == TOKEN  and  chain_id == 10143  and  value <= 0
 *                        and  function == approve  and  approve.amount <= PARAM_LIMIT
 * Cases: allowed approve; amount+1; transfer on the same token; approve at another
 * address; plain value send; approve carrying value.  Everything but the first
 * must be rejected => "no matching rule" denies by default.
 *
 * P2 = P1 + a trailing `method: "*"` DENY-all: the ALLOW must still win.
 * P3 (--order-test) = DENY-all first, then the ALLOW: documents whether order matters.
 *
 * Stateful (cumulative) limits are documented, not exercised: see docs/privy-findings.md.
 */

import { APIError } from "@privy-io/node";
import { type Address } from "viem";

import {
  CAIP2,
  CHAIN_ID,
  DEAD,
  PARAM_LIMIT,
  approveData,
  authContext,
  describeError,
  loadState,
  privy,
  run,
  saveState,
  signerId,
  testToken,
  transferData,
} from "./_lib";

const approveAbi = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

const hexQ = (n: bigint) => `0x${n.toString(16)}`;

function allowRule(token: Address) {
  return {
    name: "allow approve(<=limit) on the test token",
    method: "eth_sendTransaction" as const,
    action: "ALLOW" as const,
    conditions: [
      { field_source: "ethereum_transaction" as const, field: "to" as const, operator: "eq" as const, value: token },
      { field_source: "ethereum_transaction" as const, field: "chain_id" as const, operator: "eq" as const, value: String(CHAIN_ID) },
      { field_source: "ethereum_transaction" as const, field: "value" as const, operator: "lte" as const, value: "0x0" },
      { field_source: "ethereum_calldata" as const, field: "function_name", abi: approveAbi, operator: "eq" as const, value: "approve" },
      { field_source: "ethereum_calldata" as const, field: "approve.amount", abi: approveAbi, operator: "lte" as const, value: hexQ(PARAM_LIMIT) },
    ],
  };
}
const denyAll = { name: "deny everything else", method: "*" as const, action: "DENY" as const, conditions: [] };

run(async () => {
  const p = privy();
  const token = testToken();
  const state = loadState();
  if (!state.serverWalletId) throw new Error("run 01-server-wallet.ts first (no server wallet in .e2e/privy-spike.json)");
  const walletId = state.serverWalletId;
  const owner_id = signerId();
  const authorization_context = authContext();

  // gas_limit is fixed on purpose. Without it Privy estimates gas first, and a call that would
  // revert (transfer with no balance, approve carrying value) fails with
  // `transaction_broadcast_failure` before we learn whether the POLICY allowed it.
  const send = (transaction: { to: Address; data?: `0x${string}`; value?: string }) =>
    p.wallets().ethereum().sendTransaction(walletId, {
      caip2: CAIP2,
      params: { transaction: { ...transaction, gas_limit: "0x30d40" } },
      authorization_context,
    });

  /**
   * What the policy engine decided. Only `policy_violation` counts as a policy rejection;
   * any other error means the policy let the request through and something else failed.
   */
  const probe = async (label: string, fn: () => Promise<{ hash: string }>) => {
    try {
      const { hash } = await fn();
      console.log(`  [ALLOWED BY POLICY] ${label} -> ${hash}`);
      return `ALLOWED ${hash}`;
    } catch (error) {
      const text = describeError(error);
      if (error instanceof APIError && (error.error as { code?: string } | undefined)?.code === "policy_violation") {
        console.log(`  [POLICY DENIED] ${label}\n      ${text}`);
        return `POLICY DENIED ${text}`;
      }
      console.log(`  [NOT A POLICY DECISION] ${label}\n      ${text}`);
      return `NOT POLICY ${text}`;
    }
  };

  const createPolicy = async (name: string, rules: unknown[]) => {
    const policy = await p.policies().create({ name, version: "1.0", chain_type: "ethereum", rules: rules as never, owner_id });
    console.log(`created policy ${policy.id} (${name})`);
    return policy.id;
  };
  const attach = async (policyId: string) => {
    await p.wallets().update(walletId, { policy_ids: [policyId], authorization_context });
    console.log(`attached ${policyId} to wallet ${walletId}`);
  };

  const cases = async (label: string) => {
    console.log(`\n== ${label}`);
    const out: Record<string, string> = {};
    // Expected: allowed -> ALLOWED; every other case -> POLICY DENIED.
    out.allowed = await probe(`approve(dead, ${PARAM_LIMIT}) [at the limit]`, () => send({ to: token, data: approveData(DEAD, PARAM_LIMIT), value: "0x0" }));
    out.overLimit = await probe(`approve amount ${PARAM_LIMIT + 1n} (limit ${PARAM_LIMIT})`, () =>
      send({ to: token, data: approveData(DEAD, PARAM_LIMIT + 1n), value: "0x0" }),
    );
    out.otherFunction = await probe("transfer() on the allowed token", () => send({ to: token, data: transferData(DEAD, 1n), value: "0x0" }));
    out.otherAddress = await probe("approve() at a different address", () => send({ to: DEAD, data: approveData(DEAD, 1n), value: "0x0" }));
    out.plainValue = await probe("plain 1 wei transfer", () => send({ to: DEAD, value: "0x1" }));
    out.withValue = await probe("approve() carrying value", () => send({ to: token, data: approveData(DEAD, 1n), value: "0x1" }));
    return out;
  };

  const report: Record<string, unknown> = { token, limit: PARAM_LIMIT.toString() };

  const p1 = await createPolicy("laxu-spike P1 allow-only", [allowRule(token)]);
  await attach(p1);
  report.P1_allowOnly = await cases("P1: one ALLOW rule, no DENY-all (is no-match a deny?)");
  saveState({ policyId: p1 });

  // Run 1 (2026-10-08) showed a DENY-all rule overrides the ALLOW whatever the order, so P2 and
  // P3 are skipped by default; `--only-p1` is kept for readability, `--with-deny-all` re-runs them.
  if (process.argv.includes("--with-deny-all")) {
    const p2 = await createPolicy("laxu-spike P2 allow + deny-all", [allowRule(token), denyAll]);
    await attach(p2);
    report.P2_allowThenDenyAll = await cases("P2: ALLOW then DENY-all (ALLOW must still win)");
    saveState({ denyAllPolicyId: p2 });

    if (process.argv.includes("--order-test")) {
      const p3 = await createPolicy("laxu-spike P3 deny-all + allow", [denyAll, allowRule(token)]);
      await attach(p3);
      report.P3_denyAllThenAllow = await cases("P3: DENY-all FIRST, then ALLOW (does rule order matter?)");
    }
    // Leave the allow-only policy attached: a DENY-all policy blocks everything.
    await attach(p1);
  }

  saveState({ spike12: report });
  console.log("\nRESULT 1.2\n" + JSON.stringify(report, null, 2));
  console.log(`\nPolicy id to attach when adding the signer (React addSigners policyIds): ${p1}  (allow-only; do NOT use a policy with a DENY-all rule)`);
});
