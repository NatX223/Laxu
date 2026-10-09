/**
 * Spec 05 Part 2: show Privy's policy refusing what it should (spec 2.8 item 5 and the demo video).
 *
 *   npx ts-node --transpile-only scripts/privy/demo-rejection.ts [--rule <id>] [--full]
 *
 * Needs a protection rule whose signer is on the user's wallet (an enabled one, or any with the
 * signer added). Using ONLY the server's authorization key -- no user signature -- it asks Privy to
 * send from the protected wallet:
 *
 *   1. an allowed call:   repay(0.01 AUSD) on the protected pool          -> sent, tx hash printed
 *   2. a forbidden call:  transfer 1 unit of AUSD to another address     -> refused by Privy's policy
 *   --full adds:
 *   3. repay one unit above the rule's per-call cap                       -> refused
 *   4. repay on a different pool                                          -> refused
 *   5. approve AUSD to another address                                    -> refused
 *   and writes everything to Backend/.e2e/privy-rejections.json.
 *
 * Forbidden calls carry a fixed gas limit on purpose: without one Privy estimates gas first and a
 * call that would also revert comes back as a broadcast failure, hiding the policy's verdict
 * (docs/privy-findings.md, 1.2). They are never mined when refused; if the policy were broken they
 * would be, and each moves at most one base unit.
 *
 * The allowed call is a real (tiny) repay: it lowers the user's debt by 0.01 AUSD and uses up 0.01
 * of their protection allowance. Prints addresses, hashes and Privy's refusal text; never a key.
 */

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { encodeFunctionData, formatUnits, getAddress, type Address, type Hex } from "viem";

import { erc20Abi, lendingPoolAbi } from "../../src/chain/abi";
import { publicClient } from "../../src/chain/clients";
import { gasWithBuffer } from "../../src/chain/writes";
import { db } from "../../src/config/db";
import { config } from "../../src/config/env";
import { classifyPrivyError, describePrivyError, privyWalletSender } from "../../src/privy/signer";
import { DEAD, run } from "./_lib";

const EVIDENCE = resolve(__dirname, "../../.e2e/privy-rejections.json");
const FORBIDDEN_GAS = 200_000n;
const DEMO_REPAY = 10_000n; // 0.01 AUSD at 6 decimals

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const link = (hash: string) => (process.env.EXPLORER_URL ?? "https://testnet.monadvision.com").replace(/\/$/, "") + `/tx/${hash}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

interface Result {
  label: string;
  expected: "allowed" | "refused";
  outcome: "ALLOWED" | "REFUSED BY POLICY" | "NOT A POLICY DECISION";
  detail: string;
  ok: boolean;
}

run(async () => {
  const full = process.argv.includes("--full");
  const ruleId = arg("--rule");
  const rule = ruleId
    ? await db.protectionRule.findUnique({ where: { id: ruleId } })
    : await db.protectionRule.findFirst({ where: { privyWalletId: { not: null } }, orderBy: { updatedAt: "desc" } });
  if (!rule?.privyWalletId) throw new Error("no protection rule with a Privy wallet found (pass --rule <id>)");

  const sender = privyWalletSender();
  const pool = getAddress(rule.poolAddress);
  const wallet = getAddress(rule.walletAddress);
  const asset = getAddress(config.assetAddress);
  const maxPerCall = BigInt(rule.maxPerCall);
  const other = (await db.lendingPool.findFirst({ where: { poolAddress: { not: rule.poolAddress } } }))?.poolAddress;
  const otherPool = getAddress(other ?? DEAD);

  console.log("\nLaxu loan protection: what Privy allows and refuses");
  console.log(`  wallet ${wallet}`);
  console.log(`  pool   ${pool}`);
  console.log(`  rule   per-call cap ${formatUnits(maxPerCall, 6)} AUSD, policy ${rule.privyPolicyId}\n`);

  const results: Result[] = [];

  const send = (to: Address, data: Hex, gas: bigint) =>
    sender.sendTx(rule.privyWalletId as string, { to, data, value: 0n, gas, chainId: config.chainId });

  // 1. The allowed call -------------------------------------------------------------------
  {
    const label = `repay ${formatUnits(DEMO_REPAY, 6)} AUSD on the protected pool`;
    try {
      const call = { address: pool, abi: lendingPoolAbi, functionName: "repay", args: [DEMO_REPAY] } as const;
      const gas = await gasWithBuffer({ ...call, account: wallet });
      const { hash } = await send(pool, encodeFunctionData({ abi: lendingPoolAbi, functionName: "repay", args: [DEMO_REPAY] }), gas);
      const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 90_000 });
      const detail = `${receipt.status}  ${hash}  ${link(hash)}`;
      console.log(`  ALLOWED   ${label}\n            ${detail}`);
      results.push({ label, expected: "allowed", outcome: "ALLOWED", detail, ok: receipt.status === "success" });
    } catch (error) {
      const detail = describePrivyError(error);
      console.log(`  FAILED    ${label}\n            ${detail}`);
      results.push({ label, expected: "allowed", outcome: "NOT A POLICY DECISION", detail, ok: false });
    }
  }

  // 2.. Forbidden calls --------------------------------------------------------------------
  const forbidden: Array<[string, Address, Hex]> = [
    [
      "transfer 1 unit of AUSD out of the wallet",
      asset,
      encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [DEAD, 1n] }),
    ],
  ];
  if (full) {
    forbidden.push(
      [
        `repay ${formatUnits(maxPerCall + 1n, 6)} AUSD, one unit over the per-call cap`,
        pool,
        encodeFunctionData({ abi: lendingPoolAbi, functionName: "repay", args: [maxPerCall + 1n] }),
      ],
      [
        `repay on a different pool (${short(otherPool)})`,
        otherPool,
        encodeFunctionData({ abi: lendingPoolAbi, functionName: "repay", args: [1n] }),
      ],
      [
        "approve AUSD to another address",
        asset,
        encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [DEAD, 1n] }),
      ],
    );
  }

  for (const [label, to, data] of forbidden) {
    try {
      const { hash } = await send(to, data, FORBIDDEN_GAS);
      const detail = `SENT ${hash}  (the policy let a forbidden call through!)`;
      console.log(`  ALLOWED   ${label}\n            ${detail}`);
      results.push({ label, expected: "refused", outcome: "ALLOWED", detail, ok: false });
    } catch (error) {
      const refused = classifyPrivyError(error) === "policy";
      const detail = describePrivyError(error);
      console.log(`  ${refused ? "REFUSED  " : "ERROR    "} ${label}\n            ${detail}`);
      results.push({ label, expected: "refused", outcome: refused ? "REFUSED BY POLICY" : "NOT A POLICY DECISION", detail, ok: refused });
    }
  }

  const bad = results.filter((r) => !r.ok);
  console.log(bad.length === 0 ? "\nAll as expected: Laxu can repay this loan and nothing else." : `\n${bad.length} result(s) NOT as expected, see above.`);

  if (full) {
    mkdirSync(dirname(EVIDENCE), { recursive: true });
    writeFileSync(EVIDENCE, JSON.stringify({ at: new Date().toISOString(), ruleId: rule.id, wallet, pool, results }, null, 2));
    console.log(`evidence written to ${EVIDENCE}`);
  }
  await db.$disconnect();
  if (bad.length > 0) process.exitCode = 1;
});
