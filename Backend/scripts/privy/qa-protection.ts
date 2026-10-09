/**
 * Spec 05b 7.2, the part that can run without a browser: the backend behaviour behind the QA list, driven through
 * the real service functions against the real database, chain and Privy.
 *
 *   npx ts-node --transpile-only scripts/privy/qa-protection.ts
 *
 * Needs the migration applied and a Privy user with an embedded wallet in the `users` table (the first
 * `did:privy:` user is used as the caller; a second one, if present, as "somebody else").
 *
 * What it does NOT do: it cannot sign in, add a signer (that needs the user's session), approve an allowance or
 * create a loan, so the setup, the firing repay, the turn-off and the screenshots are manual (docs/privy-findings.md).
 * It sends no transaction. It creates ONE Privy policy and a few database rows for a fixture rule and removes them
 * at the end (the policy is only deleted when the wallet has no signer, as the backend does).
 *
 * Writes Backend/.e2e/privy-qa.json. Prints pass/fail per check; exits 1 on any failure.
 */

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Address } from "viem";

import { isEmbeddedWalletOf } from "../../src/auth/privy";
import { db } from "../../src/config/db";
import { config } from "../../src/config/env";
import { HttpError } from "../../src/lib/errors";
import { createRepayPolicy, deletePolicy } from "../../src/privy/policies";
import { activateRule, createRule, listRules, runRule, turnOffRule, type Caller } from "../../src/services/protection";
import { run } from "./_lib";

const OUT = resolve(__dirname, "../../.e2e/privy-qa.json");
const results: Array<{ check: string; pass: boolean; detail: string }> = [];

function record(check: string, pass: boolean, detail: string) {
  results.push({ check, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${check}\n      ${detail}`);
}

/** Expect `fn` to throw an HttpError with this status and code. */
async function expectHttp(check: string, status: number, code: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    record(check, false, `expected ${status} ${code}, but it succeeded`);
  } catch (error) {
    const ok = error instanceof HttpError && error.status === status && error.code === code;
    record(check, ok, error instanceof HttpError ? `${error.status} ${error.code}: ${error.message}` : `unexpected: ${String(error)}`);
  }
}

run(async () => {
  const users = await db.user.findMany({ where: { privyUserId: { startsWith: "did:privy:" } }, orderBy: { createdAt: "asc" } });
  if (users.length === 0) throw new Error("no Privy user in the users table to test with");
  const me = users[0];
  const other = users[1];
  const caller: Caller = { privyUserId: me.privyUserId, walletAddress: me.walletAddress };
  const stranger: Caller | null = other ? { privyUserId: other.privyUserId, walletAddress: other.walletAddress } : null;
  const pool = await db.lendingPool.findFirst({ orderBy: { createdAt: "asc" } });
  if (!pool) throw new Error("no lending pool in the database");
  console.log(`caller ${me.tag} ${me.walletAddress}\npool   ${pool.poolAddress}\n`);

  const good = { pool: pool.poolAddress, triggerHealth: "1.15", targetHealth: "1.30", maxSpend: "50" };

  // --- validation and refusals (POST /protection) -------------------------------------------------
  await expectHttp("create: trigger below 1.05 is refused", 400, "INVALID_TRIGGER", () => createRule(caller, { ...good, triggerHealth: "1.04" }));
  await expectHttp("create: target under trigger + 0.10 is refused", 400, "INVALID_TARGET", () => createRule(caller, { ...good, targetHealth: "1.20" }));
  await expectHttp("create: max spend above the cap is refused", 400, "MAX_SPEND_TOO_HIGH", () =>
    createRule(caller, { ...good, maxSpend: String(Number(config.protectionMaxSpendCap) / 1e6 + 1) }),
  );
  await expectHttp("create: an address that is not a Laxu pool is refused", 400, "UNKNOWN_POOL", () =>
    createRule(caller, { ...good, pool: "0x000000000000000000000000000000000000dEaD" }),
  );
  await expectHttp("create: no loan on the pool is refused (QA 2: 'Borrow first')", 400, "NO_LOAN", () => createRule(caller, good));

  // --- the embedded-wallet check (QA 1, the part that can run) -----------------------------------
  record(
    "embedded check: the user's own wallet is recognised as embedded",
    (await isEmbeddedWalletOf(me.privyUserId, me.walletAddress)) === true,
    me.walletAddress,
  );
  record(
    "embedded check: an address that is not the user's wallet is not",
    (await isEmbeddedWalletOf(me.privyUserId, "0x000000000000000000000000000000000000dEaD")) === false,
    "0x…dEaD",
  );
  if (stranger) {
    record(
      "embedded check: another user's wallet does not count for this user",
      (await isEmbeddedWalletOf(me.privyUserId, stranger.walletAddress)) === false,
      stranger.walletAddress,
    );
  }
  // NOTE: no user in this database signs in with an external wallet, so the NOT_EMBEDDED_WALLET answer itself
  // (QA 1) is only covered by the eligibility cases in App/scripts/checkProtectionMath.mjs.

  // --- a fixture rule: a real Privy policy and a rule row in the `setup` phase ---------------------
  let policyId: string | null = null;
  let ruleId: string | null = null;
  try {
    policyId = await createRepayPolicy({ pool: pool.poolAddress, maxPerCall: 25_000_000n, chainId: config.chainId });
    const rule = await db.protectionRule.create({
      data: {
        privyUserId: me.privyUserId,
        walletAddress: me.walletAddress,
        poolAddress: pool.poolAddress,
        positionToken: pool.positionTokenAddress,
        triggerHealth: "1.1500",
        targetHealth: "1.3000",
        maxSpend: "50000000",
        maxPerCall: "25000000",
        privyPolicyId: policyId,
        privyWalletId: null,
      },
    });
    ruleId = rule.id;
    await db.protectionEvent.create({ data: { ruleId, kind: "CREATED", note: "qa fixture" } });

    const list1 = await listRules(caller);
    const row1 = list1.rules.find((r) => r.id === ruleId) as Record<string, unknown> | undefined;
    record("list: a created, unfinished rule is in the phase `setup`", row1?.phase === "setup", `phase ${row1?.phase}`);
    record(
      "list: returns maxSpendCap, walletNativeBalance and the per-rule fields the card needs",
      list1.maxSpendCap === config.protectionMaxSpendCap &&
        typeof list1.walletNativeBalance === "string" &&
        row1 !== undefined &&
        "walletHasSigner" in row1 &&
        "allowance" in row1,
      `cap ${list1.maxSpendCap}, MON wei ${list1.walletNativeBalance}, walletHasSigner ${String(row1?.walletHasSigner)}, allowance ${String(row1?.allowance)}`,
    );
    record("list: no signer on the wallet yet (asked of Privy, not assumed)", row1?.walletHasSigner === false, `walletHasSigner ${String(row1?.walletHasSigner)}`);
    record("list: allowance to the pool read on chain", row1?.allowance === "0", `allowance ${String(row1?.allowance)}`);

    // activate with no signer: the backend must not believe the client (QA 7 / 8 server side)
    await expectHttp("activate: refused while Laxu's signer is not on the wallet", 409, "SIGNER_MISSING", () => activateRule(caller, ruleId!));
    const afterActivate = await db.protectionRule.findUniqueOrThrow({ where: { id: ruleId } });
    record("activate: the refused rule stays disabled and unverified", !afterActivate.enabled && afterActivate.signerVerifiedAt === null, `enabled ${afterActivate.enabled}`);

    // ownership: somebody else's id looks like no id at all
    if (stranger) {
      await expectHttp("turn off: another user cannot touch this rule", 404, "NOT_FOUND", () => turnOffRule(stranger, ruleId!));
      await expectHttp("activate: another user cannot touch this rule", 404, "NOT_FOUND", () => activateRule(stranger, ruleId!));
    }

    // cancel setup: recorded once, and the phase becomes `off`
    await turnOffRule(caller, ruleId);
    await turnOffRule(caller, ruleId); // a repeat must not write a second event
    const cancelled = await db.protectionEvent.count({ where: { ruleId, kind: "DISABLED" } });
    const list2 = await listRules(caller);
    const row2 = list2.rules.find((r) => r.id === ruleId) as Record<string, unknown> | undefined;
    record("cancel setup: recorded once, however many times it is asked", cancelled === 1, `${cancelled} DISABLED event(s)`);
    record("cancel setup: the phase is now `off`", row2?.phase === "off", `phase ${row2?.phase}`);

    // worker: an enabled, verified rule on a wallet with no debt
    await db.protectionRule.update({
      where: { id: ruleId },
      data: { enabled: true, signerVerifiedAt: new Date(), privyWalletId: "qa-fixture-wallet" },
    });
    let fresh = await db.protectionRule.findUniqueOrThrow({ where: { id: ruleId } });
    const first = await runRule(fresh);
    fresh = await db.protectionRule.findUniqueOrThrow({ where: { id: ruleId } });
    await runRule(fresh);
    const skipped = await db.protectionEvent.findMany({ where: { ruleId, kind: "SKIPPED" } });
    record(
      "worker: no debt -> `no-debt`, one SKIPPED event, not one per tick",
      typeof first === "object" && first.kind === "no-debt" && skipped.length === 1,
      `decision ${typeof first === "object" ? first.kind : first}, ${skipped.length} SKIPPED event(s) after two ticks`,
    );
    const sentNothing = (await db.protectionEvent.count({ where: { ruleId, kind: { in: ["PENDING", "REPAID", "FAILED"] } } })) === 0;
    record("worker: no repay was attempted", sentNothing, "no PENDING / REPAID / FAILED events");

    // rule 7: the rule's wallet no longer matches the user's resolved wallet -> never act, switch off
    await db.protectionRule.update({ where: { id: ruleId }, data: { walletAddress: "0x000000000000000000000000000000000000dead" } });
    fresh = await db.protectionRule.findUniqueOrThrow({ where: { id: ruleId } });
    await runRule(fresh);
    const mismatch = await db.protectionRule.findUniqueOrThrow({ where: { id: ruleId } });
    record(
      "worker: a wallet that no longer matches the user switches the rule off (rule 7)",
      !mismatch.enabled && /wallet changed/.test(mismatch.lastNote ?? ""),
      `enabled ${mismatch.enabled}, note "${mismatch.lastNote}"`,
    );
  } finally {
    // The fixture goes: events, the rule, and the policy (the wallet has no signer, so nothing can still hold it).
    if (ruleId) {
      await db.protectionEvent.deleteMany({ where: { ruleId } });
      await db.protectionRule.delete({ where: { id: ruleId } }).catch(() => undefined);
    }
    if (policyId) await deletePolicy(policyId).catch((e) => console.log(`(could not delete the fixture policy ${policyId}: ${String(e).slice(0, 120)})`));
    const left = await db.protectionRule.count();
    record("cleanup: no fixture rows left in protection_rules", left === 0, `${left} row(s)`);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), caller: me.walletAddress as Address, results }, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Evidence: ${OUT}`);
  await db.$disconnect();
  if (failed.length > 0) process.exitCode = 1;
});
