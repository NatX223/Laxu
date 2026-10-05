import assert from "node:assert/strict";
import test from "node:test";

import { assertRecycleWithinPayout, planRecycle, RecycleGuardError } from "./margin";

const RESERVE = 100_000_000n; // $100, the slot reserve on testnet

test("recycle: after a redeem or trigger exit, it withdraws at most the payout it funded", () => {
  // Regression (docs/e2e-run.md incident 5): after B's redeem the account held
  // $12.390055 above the reserve -- the freed margin PLUS the open's sizing
  // buffer -- and the old code swept all of it for a $9.787388 payout.
  assert.equal(planRecycle({ free: RESERVE + 12_390_055n, reserve: RESERVE, paidOut: 9_787_388n }), 9_787_388n, "redeem");
  // B's trigger exit: $9.333299 paid out, $9.012555 free -> only what is free.
  assert.equal(planRecycle({ free: RESERVE + 9_012_555n, reserve: RESERVE, paidOut: 9_333_299n }), 9_012_555n, "trigger exit");
  // Nothing above the reserve, or nothing paid out: nothing moves.
  assert.equal(planRecycle({ free: RESERVE, reserve: RESERVE, paidOut: 5_000_000n }), 0n);
  assert.equal(planRecycle({ free: RESERVE - 1n, reserve: RESERVE, paidOut: 5_000_000n }), 0n);
  assert.equal(planRecycle({ free: RESERVE + 7_000_000n, reserve: RESERVE, paidOut: 0n }), 0n);
});

test("recycle guard: refuses (and alerts) a withdrawal above the payout it funded", () => {
  assert.doesNotThrow(() => assertRecycleWithinPayout(9_787_388n, 9_787_388n));
  assert.doesNotThrow(() => assertRecycleWithinPayout(0n, 9_787_388n));
  assert.throws(() => assertRecycleWithinPayout(12_390_055n, 9_787_388n, { positionId: "p" }), RecycleGuardError);
});
