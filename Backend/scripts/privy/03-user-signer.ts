/**
 * Spec 05 spike 1.3: act on a USER's embedded wallet through the server signer.
 *
 *   npx ts-node --transpile-only scripts/privy/03-user-signer.ts --wallet 0xUSER [--policy pol_id] [--expect-removed]
 *
 * Run after the user clicked "Add signer" on /dev/privy (the page attaches the
 * policy printed at the end of 02-policy.ts). Looks the wallet up by address,
 * checks our key quorum is among its additional signers, then sends the same
 * allowed and forbidden calls as 02 using only the server's authorization key
 * (no user signature).
 *
 * With --expect-removed (run after "Remove signer") the allowed call must now
 * fail: this answers "does removing the signer actually stop further calls?".
 *
 * The user's wallet needs a little MON for gas (~0.005).
 */

import { APIError } from "@privy-io/node";
import { parseEther, type Address } from "viem";

import { publicClient } from "../../src/chain/clients";
import {
  CAIP2,
  DEAD,
  PARAM_LIMIT,
  approveData,
  authContext,
  describeError,
  privy,
  run,
  saveState,
  signerId,
  testToken,
  transferData,
} from "./_lib";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

run(async () => {
  const address = arg("--wallet") as Address | undefined;
  if (!address) {
    console.error("usage: 03-user-signer.ts --wallet 0xUSER_EMBEDDED_WALLET [--expect-removed]");
    process.exit(64);
  }
  const p = privy();
  const token = testToken();
  const quorum = signerId();
  const authorization_context = authContext();

  const wallet = await p.wallets().getWalletByAddress({ address });
  const signers = (wallet.additional_signers ?? []) as Array<{ signer_id: string; override_policy_ids?: string[] }>;
  const ours = signers.find((s) => s.signer_id === quorum);
  console.log(`wallet ${wallet.id} owner_id=${wallet.owner_id} wallet.policy_ids=${JSON.stringify(wallet.policy_ids)}`);
  console.log(`additional_signers: ${signers.length}; ours present: ${Boolean(ours)}; its policy ids: ${JSON.stringify(ours?.override_policy_ids ?? [])}`);

  // Without our signer every call is a 401 whatever the policy says, which proves nothing about
  // the policy. Only `--expect-removed` is meant to run in that state.
  if (!ours && !process.argv.includes("--expect-removed")) {
    console.log("\nOur signer is NOT on this wallet, so there is nothing to test. Click \"Add signer\" on /dev/privy first, then re-run this immediately.");
    process.exit(3);
  }
  if (ours && process.argv.includes("--expect-removed")) {
    console.log("\nWarning: our signer is STILL on this wallet; the result below is not a post-removal result.");
  }

  const balance = await publicClient().getBalance({ address });
  console.log(`balance ${balance} wei`);
  if (balance < parseEther("0.005")) {
    console.log(`\nSend ~0.01 MON to ${address} (gas), then re-run.`);
    process.exit(3);
  }

  // Fixed gas_limit: without it Privy estimates gas first and a call that would revert is
  // reported as `transaction_broadcast_failure`, hiding the policy decision (see 02-policy.ts).
  const send = (transaction: { to: Address; data?: `0x${string}`; value?: string }) =>
    p.wallets().ethereum().sendTransaction(wallet.id, {
      caip2: CAIP2,
      params: { transaction: { ...transaction, gas_limit: "0x30d40" } },
      authorization_context,
    });

  /** Only `policy_violation` is a policy decision; any other error means the policy let it through. */
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

  const out: Record<string, unknown> = { signerPresent: Boolean(ours), policyIdsOnSigner: ours?.override_policy_ids ?? [] };

  if (process.argv.includes("--expect-removed")) {
    // Expected after removal: not ALLOWED. The error text says whether Privy refuses the request outright.
    out.afterRemoval = await probe("allowed approve() after the signer was removed", () =>
      send({ to: token, data: approveData(DEAD, PARAM_LIMIT), value: "0x0" }),
    );
  } else {
    // Expected: allowed -> ALLOWED; every other case -> POLICY DENIED.
    out.allowed = await probe(`approve(dead, ${PARAM_LIMIT}) [at the limit]`, () => send({ to: token, data: approveData(DEAD, PARAM_LIMIT), value: "0x0" }));
    out.overLimit = await probe(`approve amount ${PARAM_LIMIT + 1n}`, () => send({ to: token, data: approveData(DEAD, PARAM_LIMIT + 1n), value: "0x0" }));
    out.otherFunction = await probe("transfer() on the token", () => send({ to: token, data: transferData(DEAD, 1n), value: "0x0" }));
    out.otherAddress = await probe("approve() at another address", () => send({ to: DEAD, data: approveData(DEAD, 1n), value: "0x0" }));
  }

  saveState({ spike13: out });
  console.log("\nRESULT 1.3\n" + JSON.stringify(out, null, 2));
});
