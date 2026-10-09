import assert from "node:assert/strict";
import test from "node:test";

import { healthToWad } from "./protectionMath";
import {
  ProtectionInputError,
  decide,
  gasShortfall,
  pendingState,
  ruleResetData,
  shouldRecordSkip,
  skipNote,
  validateRuleInput,
  type Basics,
  type Detail,
  type Reader,
  type RuleView,
} from "./protectionRules";

const AUSD = 1_000_000n;
const CAP = 500n * AUSD;

const ok = { triggerHealth: "1.15", targetHealth: "1.30", maxSpend: "100" };

function rejects(input: Partial<typeof ok>, code: string) {
  assert.throws(
    () => validateRuleInput({ ...ok, ...input }, 6, CAP),
    (error) => error instanceof ProtectionInputError && error.code === code,
    JSON.stringify(input),
  );
}

test("validation: the happy path, and what it normalises", () => {
  const rule = validateRuleInput(ok, 6, CAP);
  assert.equal(rule.triggerHealth, "1.1500");
  assert.equal(rule.targetHealth, "1.3000");
  assert.equal(rule.triggerWad, healthToWad("1.15"));
  assert.equal(rule.maxSpend, 100n * AUSD);
  assert.equal(rule.maxPerCall, 50n * AUSD); // half, so one call can never spend everything
});

test("validation: trigger bounds 1.05 to 3.0 inclusive", () => {
  assert.equal(validateRuleInput({ ...ok, triggerHealth: "1.05", targetHealth: "1.15" }, 6, CAP).triggerHealth, "1.0500");
  assert.equal(validateRuleInput({ ...ok, triggerHealth: "3.0", targetHealth: "3.1" }, 6, CAP).triggerHealth, "3.0000");
  rejects({ triggerHealth: "1.04" }, "INVALID_TRIGGER");
  rejects({ triggerHealth: "3.01", targetHealth: "3.5" }, "INVALID_TRIGGER");
  rejects({ triggerHealth: "0.9" }, "INVALID_TRIGGER");
});

test("validation: target is at least trigger + 0.10 and at most 5.0", () => {
  assert.equal(validateRuleInput({ ...ok, triggerHealth: "1.15", targetHealth: "1.25" }, 6, CAP).targetHealth, "1.2500");
  rejects({ triggerHealth: "1.15", targetHealth: "1.24" }, "INVALID_TARGET");
  rejects({ triggerHealth: "1.15", targetHealth: "1.15" }, "INVALID_TARGET");
  assert.equal(validateRuleInput({ ...ok, triggerHealth: "2.0", targetHealth: "5.0" }, 6, CAP).targetHealth, "5.0000");
  rejects({ triggerHealth: "2.0", targetHealth: "5.01" }, "INVALID_TARGET");
});

test("validation: max spend is above zero, at most the cap, and not dust", () => {
  assert.equal(validateRuleInput({ ...ok, maxSpend: "500" }, 6, CAP).maxSpend, CAP); // exactly the cap
  assert.equal(validateRuleInput({ ...ok, maxSpend: "0.02" }, 6, CAP).maxPerCall, 10_000n);
  rejects({ maxSpend: "500.000001" }, "MAX_SPEND_TOO_HIGH");
  rejects({ maxSpend: "0" }, "INVALID_MAX_SPEND");
  rejects({ maxSpend: "0.01" }, "MAX_SPEND_TOO_LOW"); // half of it is under the dust floor
  rejects({ maxSpend: "-5" }, "INVALID_MAX_SPEND");
  rejects({ maxSpend: "ten" }, "INVALID_MAX_SPEND");
  rejects({ maxSpend: "" }, "INVALID_MAX_SPEND");
});

test("validation: not-a-number health factors", () => {
  for (const bad of ["", "abc", "-1.2", "1.2.3", "1e0", "NaN"]) {
    rejects({ triggerHealth: bad }, "INVALID_HEALTH");
  }
});

// --- decision, with a fake clock and a scripted chain ------------------------------------------

const T0 = Date.parse("2026-10-09T12:00:00Z");
const rule: RuleView = {
  enabled: true,
  signerVerified: true,
  walletMatchesUser: true,
  triggerWad: healthToWad("1.15"),
  targetWad: healthToWad("1.30"),
  maxSpend: 100n * AUSD,
  maxPerCall: 50n * AUSD,
  spent: 0n,
  lastActionAtMs: null,
};

/// 1000 AUSD collateral at 80%: debt 640 -> health 1.25 (healthy for trigger 1.15); debt 760 -> 1.0526 (below).
function chain(debt: bigint, extra: Partial<Detail> = {}) {
  const calls = { basics: 0, detail: 0 };
  const reader: Reader = {
    async basics(): Promise<Basics> {
      calls.basics += 1;
      return { debt, health: debt === 0n ? 2n ** 256n - 1n : (1000n * AUSD * 8_000n * 10n ** 18n) / (10_000n * debt) };
    },
    async detail(): Promise<Detail> {
      calls.detail += 1;
      return { collateralValue: 1000n * AUSD, thresholdBps: 8_000n, balance: 1000n * AUSD, allowance: 100n * AUSD, ...extra };
    },
  };
  return { reader, calls };
}

test("decide: rule 7 guards come first and cost no chain read", async () => {
  for (const [patch, why] of [
    [{ enabled: false }, "disabled"],
    [{ signerVerified: false }, "signer-unverified"],
    [{ walletMatchesUser: false }, "wallet-mismatch"],
  ] as const) {
    const { reader, calls } = chain(760n * AUSD);
    assert.deepEqual(await decide({ ...rule, ...patch }, reader, T0, 60), { kind: "idle", why });
    assert.equal(calls.basics, 0);
  }
});

test("decide: no debt, and healthy, read only the basics", async () => {
  const none = chain(0n);
  assert.deepEqual(await decide(rule, none.reader, T0, 60), { kind: "no-debt" });
  assert.equal(none.calls.detail, 0);

  const fine = chain(640n * AUSD); // health 1.25 > trigger 1.15
  const decision = await decide(rule, fine.reader, T0, 60);
  assert.equal(decision.kind, "healthy");
  assert.equal(fine.calls.detail, 0);
});

test("decide: at the trigger exactly it acts (<=), one unit above it does not", async () => {
  const exact = { ...rule, triggerWad: healthToWad("1.25") }; // debt 640 has health exactly 1.25
  assert.equal((await decide(exact, chain(640n * AUSD).reader, T0, 60)).kind, "repay");
  const above = { ...rule, triggerWad: healthToWad("1.25") - 1n };
  assert.equal((await decide(above, chain(640n * AUSD).reader, T0, 60)).kind, "healthy");
});

test("decide: below the trigger it repays toward the target within every limit", async () => {
  const { reader, calls } = chain(760n * AUSD);
  const decision = await decide(rule, reader, T0, 60);
  assert.equal(decision.kind, "repay");
  assert.equal(calls.detail, 1);
  if (decision.kind !== "repay") return;
  // Debt 760 -> target 1.30 wants debt 615.38: about 144.6 + 1% buffer, cut to the 50 AUSD per-call cap.
  assert.equal(decision.amount, 50n * AUSD);
  assert.equal(decision.plan.limitedBy, "maxPerCall");
});

test("decide: cooldown, with a fake clock", async () => {
  const acted = { ...rule, lastActionAtMs: T0 };
  const during = await decide(acted, chain(760n * AUSD).reader, T0 + 30_000, 60);
  assert.equal(during.kind, "cooldown");
  if (during.kind === "cooldown") assert.equal(during.retryInS, 30);

  assert.equal((await decide(acted, chain(760n * AUSD).reader, T0 + 59_999, 60)).kind, "cooldown");
  assert.equal((await decide(acted, chain(760n * AUSD).reader, T0 + 60_000, 60)).kind, "repay"); // window over

  // Cooldown is checked before the detail reads are paid for.
  const { reader, calls } = chain(760n * AUSD);
  await decide(acted, reader, T0 + 1_000, 60);
  assert.equal(calls.detail, 0);

  // Cooldown 0 never blocks.
  assert.equal((await decide(acted, chain(760n * AUSD).reader, T0, 0)).kind, "repay");
});

test("decide: cannot act -> skip with the reason", async () => {
  const empty = await decide(rule, chain(760n * AUSD, { balance: 0n }).reader, T0, 60);
  assert.equal(empty.kind === "skip" && empty.reason, "balance");

  const noAllowance = await decide(rule, chain(760n * AUSD, { allowance: 0n }).reader, T0, 60);
  assert.equal(noAllowance.kind === "skip" && noAllowance.reason, "allowance");

  const spentOut = await decide({ ...rule, spent: 100n * AUSD }, chain(760n * AUSD).reader, T0, 60);
  assert.equal(spentOut.kind === "skip" && spentOut.reason, "remainingSpend");

  // Partly spent: only what is left is sent.
  const partly = await decide({ ...rule, spent: 80n * AUSD }, chain(760n * AUSD).reader, T0, 60);
  assert.equal(partly.kind === "repay" && partly.amount, 20n * AUSD);
});

test("skip notes are plain words and name what the user can do", () => {
  assert.match(skipNote("balance", "AUSD", 100n * AUSD, 6), /add AUSD to your wallet/);
  assert.match(skipNote("remainingSpend", "AUSD", 100n * AUSD, 6), /100 AUSD\) is used up/);
  assert.match(skipNote("allowance", "AUSD", 100n * AUSD, 6), /allowance is used up/);
});

test("a 'could not act' note is written once per cooldown window", () => {
  const note = "Protection could not act: add AUSD to your wallet so it can repay.";
  const last = { kind: "SKIPPED", note, createdAtMs: T0 };
  assert.equal(shouldRecordSkip(null, note, T0, 60), true);
  assert.equal(shouldRecordSkip(last, note, T0 + 59_000, 60), false);
  assert.equal(shouldRecordSkip(last, note, T0 + 60_000, 60), true);
  // A different reason is news straight away; so is anything after a non-skip event.
  assert.equal(shouldRecordSkip(last, "Protection stopped: ...", T0 + 1_000, 60), true);
  assert.equal(shouldRecordSkip({ ...last, kind: "REPAID" }, note, T0 + 1_000, 60), true);
});

test("a PENDING marker blocks the rule while fresh and is settled once stale", () => {
  const stale = 10 * 60_000;
  assert.equal(pendingState(T0, T0 + 5_000, stale), "in-flight");
  assert.equal(pendingState(T0, T0 + stale - 1, stale), "in-flight");
  assert.equal(pendingState(T0, T0 + stale, stale), "stale");
});

// --- Spec 05b section 6: gas check and re-enable ------------------------------------------------------

test("gas gate: the wallet must cover the gas LIMIT at the fee cap (Monad bills the limit)", () => {
  const gwei = 10n ** 9n;
  // 200_000 gas at 102 gwei = 0.0204 MON, the cost actually observed on testnet.
  const need = 200_000n * 102n * gwei;
  assert.equal(need, 20_400_000_000_000_000n);
  assert.equal(gasShortfall(need, 200_000n, 102n * gwei), null, "exactly enough");
  assert.equal(gasShortfall(need + 1n, 200_000n, 102n * gwei), null);
  assert.equal(gasShortfall(need - 1n, 200_000n, 102n * gwei), 1n, "one wei short");
  assert.equal(gasShortfall(0n, 200_000n, 102n * gwei), need, "an empty wallet is short by all of it");
  assert.equal(gasShortfall(5n, 200_000n, 0n), null, "no fee, nothing needed");
});

test("gas skip note says what to do, in plain words", () => {
  assert.match(skipNote("gas", "AUSD", 100n * AUSD, 6), /^Add MON for gas/);
  // Not confused with the asset notes.
  assert.doesNotMatch(skipNote("gas", "AUSD", 100n * AUSD, 6), /AUSD/);
});

test("re-enable: a rule created again starts clean whatever the old one had", () => {
  const valid = validateRuleInput({ triggerHealth: "1.20", targetHealth: "1.40", maxSpend: "80" }, 6, CAP);
  const reset = ruleResetData(valid, "policy_new", "wallet_id");
  assert.deepEqual(reset, {
    triggerHealth: "1.2000",
    targetHealth: "1.4000",
    maxSpend: "80000000",
    maxPerCall: "40000000",
    spent: "0", // not the old rule's spend
    privyPolicyId: "policy_new", // the new policy, not the old one
    privyWalletId: "wallet_id",
    enabled: false, // never on until the backend has verified signer and allowance again
    signerVerifiedAt: null,
    lastActionAt: null, // no inherited cooldown
    lastCheckedAt: null,
    lastNote: null, // no stale banner
  });
});
