/**
 * Spec 05b 3.4: the App's repay preview must give the same answers as the backend's planRepay.
 *
 *   node scripts/checkProtectionMath.mjs
 *
 * The App has no test runner, so this is the check. `expected` was produced by running the SAME six vectors
 * through Backend/src/services/protectionMath.ts (planRepay); the script runs them through
 * src/lib/protectionMath.ts (previewRepay) and fails on any difference. To regenerate `expected`, run the
 * backend function on these inputs again. Needs Node 22+ (it loads the .ts file directly).
 */

import assert from "node:assert/strict";
import { getProtectionEligibility } from "../src/lib/protectionEligibility.ts";
import { previewRepay } from "../src/lib/protectionMath.ts";

const U = 1_000_000n; // 6 decimals
const base = {
  debt: 640n * U,
  collateralValue: 1000n * U,
  thresholdBps: 8000n,
  targetHealth: "1.30",
  maxPerCall: 500n * U,
  maxSpend: 1000n * U,
  spent: 0n,
  walletBalance: 1000n * U,
  allowance: 1000n * U,
};

const vectors = [
  { name: "V1 unconstrained", input: base, expected: { amount: "24861539", needed: "24861539", limitedBy: null, reason: "ok" } },
  { name: "V2 per-call cap binds", input: { ...base, maxPerCall: 10n * U }, expected: { amount: "10000000", needed: "24861539", limitedBy: "maxPerCall", reason: "ok" } },
  { name: "V3 wallet balance binds", input: { ...base, walletBalance: 5n * U }, expected: { amount: "5000000", needed: "24861539", limitedBy: "balance", reason: "ok" } },
  { name: "V4 already at target", input: { ...base, debt: 600n * U }, expected: { amount: "0", needed: "0", limitedBy: null, reason: "already-at-target" } },
  { name: "V5 allowance binds, spend partly used", input: { ...base, spent: 995n * U, allowance: 3n * U }, expected: { amount: "3000000", needed: "24861539", limitedBy: "allowance", reason: "ok" } },
  { name: "V6 under the dust floor", input: { ...base, debt: 615_384_615n + 1_000n }, expected: { amount: "0", needed: "1010", limitedBy: null, reason: "dust" } },
];

let failed = 0;
for (const { name, input, expected } of vectors) {
  const got = previewRepay(input);
  const actual = { amount: got.amount.toString(), needed: got.needed.toString(), limitedBy: got.limitedBy, reason: got.reason };
  try {
    assert.deepEqual(actual, expected);
    console.log(`ok   ${name}  amount ${actual.amount}  (${actual.reason}${actual.limitedBy ? `, limited by ${actual.limitedBy}` : ""})`);
  } catch {
    failed += 1;
    console.log(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  }
}
console.log(failed === 0 ? `\nAll ${vectors.length} vectors match the backend.` : `\n${failed} vector(s) differ from the backend.`);

// --- who sees the card (Spec 05b 2 / 7.1) ---------------------------------------------------------------
const ME = "0xfc7d5c97ec539215fab84a732b74f5dce6833d21";
const embedded = { address: ME, walletClientType: "privy" };
const user = { walletAddress: ME };
const eligibility = [
  ["no pool yet", { wallet: embedded, user, debt: 5n, hasPool: false }, "hidden"],
  ["not logged in (no user)", { wallet: embedded, user: null, debt: 5n, hasPool: true }, "hidden"],
  ["wallet not connected yet", { wallet: null, user, debt: 5n, hasPool: true }, "hidden"],
  ["debt not loaded yet", { wallet: embedded, user, debt: null, hasPool: true }, "hidden"],
  ["external wallet (MetaMask)", { wallet: { address: ME, walletClientType: "metamask" }, user, debt: 5n, hasPool: true }, "not-embedded"],
  ["embedded wallet, but not the Laxu wallet", { wallet: { address: "0x000000000000000000000000000000000000dEaD", walletClientType: "privy" }, user, debt: 5n, hasPool: true }, "not-embedded"],
  ["address case differs (still the same wallet)", { wallet: { address: ME.toUpperCase().replace("0X", "0x"), walletClientType: "privy" }, user, debt: 5n, hasPool: true }, "eligible"],
  ["embedded, no debt", { wallet: embedded, user, debt: 0n, hasPool: true }, "no-debt"],
  ["embedded, has debt", { wallet: embedded, user, debt: 1n, hasPool: true }, "eligible"],
];
let eligFailed = 0;
for (const [name, args, expected] of eligibility) {
  const got = getProtectionEligibility(args).kind;
  if (got === expected) console.log(`ok   eligibility: ${name} -> ${got}`);
  else {
    eligFailed += 1;
    console.log(`FAIL eligibility: ${name}: expected ${expected}, got ${got}`);
  }
}
console.log(eligFailed === 0 ? `All ${eligibility.length} eligibility cases pass.` : `${eligFailed} eligibility case(s) fail.`);
process.exit(failed === 0 && eligFailed === 0 ? 0 : 1);
