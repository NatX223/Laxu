import assert from "node:assert/strict";
import test from "node:test";

import { lifecycleOf } from "./discovery";
import { nextWithdrawStep } from "./settlement";

const USD = 1_000_000n;
const fresh = { recoveredAssets: null, withdrawalId: null, withdrawStartedAt: null };

test("a fresh settlement submits a withdrawal for what is withdrawable", () => {
  assert.deepEqual(nextWithdrawStep(fresh, 850n * USD), { kind: "submit" });
});

test("a wiped liquidation (under Arcus's $1 minimum) withdraws nothing", () => {
  assert.deepEqual(nextWithdrawStep(fresh, 0n), { kind: "nothing" });
  assert.deepEqual(nextWithdrawStep(fresh, USD - 1n), { kind: "nothing" });
});

test("restart after the withdraw step never withdraws twice", () => {
  const startedAt = new Date("2026-09-24T10:00:00Z");

  // Crash after the id was saved: wait on that withdrawal, whatever the balance.
  assert.deepEqual(
    nextWithdrawStep({ ...fresh, withdrawStartedAt: startedAt, withdrawalId: "w-1" }, 850n * USD),
    { kind: "await-recorded" },
  );
  // Crash between submitting and saving the id: the subaccount is empty, so
  // it went out -- wait for it on the feed instead of submitting again.
  assert.deepEqual(nextWithdrawStep({ ...fresh, withdrawStartedAt: startedAt }, 0n), { kind: "await-unrecorded" });
  // Crash after the money arrived: use the recorded amount.
  assert.deepEqual(
    nextWithdrawStep({ recoveredAssets: "850000000", withdrawalId: "w-1", withdrawStartedAt: startedAt }, 0n),
    { kind: "recovered", amount6: 850n * USD },
  );
  // A recorded zero (wiped liquidation) is final too.
  assert.deepEqual(nextWithdrawStep({ ...fresh, recoveredAssets: "0" }, 5n * USD), { kind: "recovered", amount6: 0n });
});

test("an attempt marked started whose funds are still on the subaccount never went out", () => {
  assert.deepEqual(nextWithdrawStep({ ...fresh, withdrawStartedAt: new Date() }, 850n * USD), { kind: "submit" });
});

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
