import assert from "node:assert/strict";
import test from "node:test";

import {
  DUST_FLOOR,
  UINT256_MAX,
  WAD,
  debtAtHealth,
  formatHealth,
  healthToWad,
  planRepay,
  type RepayInput,
} from "./protectionMath";

const AUSD = 1_000_000n; // 6 decimals
const THRESHOLD = 8_000n; // 80%

/// 1000 AUSD of collateral at an 80% threshold: health = 800 / debt. Debt 640 -> health 1.25.
const base: RepayInput = {
  debt: 640n * AUSD,
  collateralValue: 1000n * AUSD,
  thresholdBps: THRESHOLD,
  targetHealth: healthToWad("1.30"),
  maxPerCall: 10_000n * AUSD,
  remainingSpend: 10_000n * AUSD,
  balance: 10_000n * AUSD,
  allowance: 10_000n * AUSD,
};

const health = (debt: bigint, collateral = 1000n * AUSD) => (collateral * THRESHOLD * WAD) / (10_000n * debt);

test("health strings: parse, format, and the no-debt sentinel", () => {
  assert.equal(healthToWad("1.15"), 1_150_000_000_000_000_000n);
  assert.equal(healthToWad("3"), 3n * WAD);
  assert.equal(formatHealth(1_150_000_000_000_000_000n), "1.1500");
  assert.equal(formatHealth(1_234_567_000_000_000_000n), "1.2345"); // truncates
  assert.equal(formatHealth(UINT256_MAX), null);
  for (const bad of ["", "abc", "-1", "1.2.3", "1e3", " "]) assert.throws(() => healthToWad(bad), /Not a health factor/, bad);
});

test("debtAtHealth is the debt that sits on the target (rounded down)", () => {
  // 800 / 1.30 = 615.384615...
  assert.equal(debtAtHealth(1000n * AUSD, THRESHOLD, healthToWad("1.30")), 615_384_615n);
  assert.throws(() => debtAtHealth(1n, THRESHOLD, 0n));
});

test("exact target: with no buffer the repay lands on (or just above) the target health", () => {
  const plan = planRepay({ ...base, bufferBps: 0n });
  assert.equal(plan.reason, "ok");
  assert.equal(plan.limitedBy, null);
  assert.equal(plan.amount, 640n * AUSD - 615_384_615n); // 24_615_385
  const after = health(base.debt - plan.amount);
  assert.ok(after >= healthToWad("1.30"), "at or above target");
  assert.ok(after < healthToWad("1.3001"), "and not by much");
});

test("buffer: 1% on top of what is needed, so interest accruing before mining cannot leave it short", () => {
  const exact = planRepay({ ...base, bufferBps: 0n }).amount;
  const buffered = planRepay(base).amount; // default 100 bps
  assert.equal(buffered, exact + (exact * 100n + 9_999n) / 10_000n);
  // 1 bp of the debt accrues between the read and the mining (far more than a minute or two of
  // interest at the pool's APR): the exact amount would now fall short, the buffered one holds.
  const accrued = base.debt + base.debt / 10_000n;
  assert.ok(health(accrued - exact) < healthToWad("1.30"), "without the buffer it misses the target");
  assert.ok(health(accrued - buffered) >= healthToWad("1.30"), "with the buffer it still reaches it");
});

test("never more than the debt", () => {
  // Collateral worth 100, debt 10, target 5.0: needed is far above the debt only if the target is absurd.
  const plan = planRepay({
    ...base,
    debt: 10n * AUSD,
    collateralValue: 10n * AUSD,
    thresholdBps: 8_000n,
    targetHealth: healthToWad("5.0"),
    bufferBps: 5_000n, // 50% buffer, to push needed past the debt
  });
  assert.equal(plan.needed, 10n * AUSD);
  assert.equal(plan.amount, 10n * AUSD);
});

test("each clamp binds on its own, and is named", () => {
  const needed = planRepay(base).amount;
  const half = needed / 2n;

  const perCall = planRepay({ ...base, maxPerCall: half });
  assert.equal(perCall.amount, half);
  assert.equal(perCall.limitedBy, "maxPerCall");

  const remaining = planRepay({ ...base, remainingSpend: half });
  assert.equal(remaining.amount, half);
  assert.equal(remaining.limitedBy, "remainingSpend");

  const balance = planRepay({ ...base, balance: half });
  assert.equal(balance.amount, half);
  assert.equal(balance.limitedBy, "balance");

  const allowance = planRepay({ ...base, allowance: half });
  assert.equal(allowance.amount, half);
  assert.equal(allowance.limitedBy, "allowance");

  // The smallest wins when several bind.
  const several = planRepay({ ...base, maxPerCall: half + 5n, balance: half - 5n, allowance: half });
  assert.equal(several.amount, half - 5n);
  assert.equal(several.limitedBy, "balance");
});

test("zero results: each reason is reported", () => {
  assert.deepEqual(planRepay({ ...base, debt: 0n }), { needed: 0n, amount: 0n, limitedBy: null, reason: "no-debt" });
  // Debt 600 against a 1.30 target already holds (health 1.333).
  const fine = planRepay({ ...base, debt: 600n * AUSD });
  assert.equal(fine.reason, "already-at-target");
  assert.equal(fine.amount, 0n);
  // Empty wallet.
  const empty = planRepay({ ...base, balance: 0n });
  assert.equal(empty.amount, 0n);
  assert.equal(empty.reason, "limit:balance");
  // Allowance used up, spend limit used up.
  assert.equal(planRepay({ ...base, allowance: 0n }).reason, "limit:allowance");
  assert.equal(planRepay({ ...base, remainingSpend: 0n }).reason, "limit:remainingSpend");
  // A negative remaining is treated as zero, never as a huge unsigned.
  assert.equal(planRepay({ ...base, remainingSpend: -5n }).amount, 0n);
});

test("dust floor: a repay not worth its gas is not sent, and says why", () => {
  // Needs a hair: debt just over the target.
  const tiny = planRepay({ ...base, debt: 615_384_615n + 1_000n, bufferBps: 0n });
  assert.equal(tiny.needed, 1_000n);
  assert.equal(tiny.amount, 0n);
  assert.equal(tiny.reason, "dust");
  // Exactly at the floor is sent.
  const atFloor = planRepay({ ...base, debt: 615_384_615n + DUST_FLOOR, bufferBps: 0n });
  assert.equal(atFloor.amount, DUST_FLOOR);
  assert.equal(atFloor.reason, "ok");
  // A clamp that leaves less than the floor is reported as that limit, not as dust.
  const clamped = planRepay({ ...base, balance: DUST_FLOOR - 1n });
  assert.equal(clamped.amount, 0n);
  assert.equal(clamped.reason, "limit:balance");
});

test("decimals: the maths is scale-free, so an 18-decimal asset gives the same result in its own units", () => {
  const unit18 = 10n ** 18n;
  const plan6 = planRepay({ ...base, bufferBps: 0n });
  const plan18 = planRepay({
    ...base,
    bufferBps: 0n,
    debt: 640n * unit18,
    collateralValue: 1000n * unit18,
    maxPerCall: 10_000n * unit18,
    remainingSpend: 10_000n * unit18,
    balance: 10_000n * unit18,
    allowance: 10_000n * unit18,
    dustFloor: 10n ** 16n,
  });
  // Same repay in whole tokens, to six places (the 6-decimal target rounds one unit differently).
  const diff = plan18.amount / 10n ** 12n - plan6.amount;
  assert.ok(diff >= -1n && diff <= 1n, `diff ${diff}`);
});
