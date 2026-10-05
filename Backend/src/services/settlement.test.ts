import assert from "node:assert/strict";
import test from "node:test";

import { lifecycleOf } from "./discovery";
import { recoverableAboveReserve } from "./settlement";


test("position lifecycle: open -> closing -> settling -> settled", () => {
  assert.equal(lifecycleOf("open", null), "open");
  assert.equal(lifecycleOf("open", "closing"), "closing");
  assert.equal(lifecycleOf("open", "withdrawing"), "settling");
  assert.equal(lifecycleOf("closed", "closing"), "settling");
  assert.equal(lifecycleOf("closed", null), "settling");
  assert.equal(lifecycleOf("closed", "settling"), "settling");
  assert.equal(lifecycleOf("settled", "settled"), "settled");
  assert.equal(lifecycleOf("settled", null), "settled");
});

test("settlement: recovered = account balance minus reserve, never negative", () => {
  // Slot reserve on testnet: 100 AUSD (Perpl's min account open amount).
  const reserve = 100_000_000n;
  assert.equal(recoverableAboveReserve(10_055_047_572n, reserve), 9_955_047_572n, "the recorded slot 1 close");
  assert.equal(recoverableAboveReserve(reserve, reserve), 0n, "at the reserve: nothing to recover");
  assert.equal(recoverableAboveReserve(40_000_000n, reserve), 0n, "below it (a wiped liquidation): 0, not negative");
  assert.equal(recoverableAboveReserve(0n, reserve), 0n);
});
