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

import { parseEther, type Address } from "viem";

import { publicClient } from "../../src/chain/clients";
import {
  CAIP2,
  DEAD,
  PARAM_LIMIT,
  approveData,
  authContext,
  describeError,
  expectRejected,
  privy,
  run,
  saveState,
  signerId,
  testToken,
  timed,
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

  const balance = await publicClient().getBalance({ address });
  console.log(`balance ${balance} wei`);
  if (balance < parseEther("0.005")) {
    console.log(`\nSend ~0.01 MON to ${address} (gas), then re-run.`);
    process.exit(3);
  }

  const send = (transaction: { to: Address; data?: `0x${string}`; value?: string }) =>
    p.wallets().ethereum().sendTransaction(wallet.id, { caip2: CAIP2, params: { transaction }, authorization_context });

  const out: Record<string, unknown> = { signerPresent: Boolean(ours), policyIdsOnSigner: ours?.override_policy_ids ?? [] };

  if (process.argv.includes("--expect-removed")) {
    out.afterRemoval = await expectRejected("allowed approve() after the signer was removed", () =>
      send({ to: token, data: approveData(DEAD, PARAM_LIMIT), value: "0x0" }),
    );
  } else {
    try {
      const { value, ms } = await timed(() => send({ to: token, data: approveData(DEAD, PARAM_LIMIT), value: "0x0" }));
      console.log(`  [allowed ] approve(dead, ${PARAM_LIMIT}) -> ${value.hash} (${ms} ms)`);
      out.allowed = `OK ${value.hash}`;
    } catch (error) {
      console.log(`  [UNEXPECTED REJECTION] allowed call: ${describeError(error)}`);
      out.allowed = `UNEXPECTED REJECTION ${describeError(error)}`;
    }
    out.overLimit = await expectRejected(`approve amount ${PARAM_LIMIT + 1n}`, () => send({ to: token, data: approveData(DEAD, PARAM_LIMIT + 1n), value: "0x0" }));
    out.otherFunction = await expectRejected("transfer() on the token", () => send({ to: token, data: transferData(DEAD, 1n), value: "0x0" }));
    out.otherAddress = await expectRejected("approve() at another address", () => send({ to: DEAD, data: approveData(DEAD, 1n), value: "0x0" }));
  }

  saveState({ spike13: out });
  console.log("\nRESULT 1.3\n" + JSON.stringify(out, null, 2));
});
