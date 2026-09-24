import assert from "node:assert/strict";
import test from "node:test";

import type { AccountTransferUpdate, ArcusFill } from "../arcus/types";
import { ACCOUNT_CHANNELS, normaliseFill, normaliseTransfer, planConnections, vwap } from "./arcusStream";
import { matchesWithdrawal } from "./arcusWithdraw";

test("30 slots x 3 channels fit one connection capped at 90; the 31st opens another", () => {
  assert.equal(ACCOUNT_CHANNELS.length, 3);
  assert.deepEqual(planConnections(30, ACCOUNT_CHANNELS.length, 90), [30]);
  assert.deepEqual(planConnections(31, ACCOUNT_CHANNELS.length, 90), [30, 1]);
});

test("live fill frames with fillSize/fillPrice normalise onto size/price", () => {
  const fill = normaliseFill({ tradeId: "t", orderId: "o", fillSize: "0.01", fillPrice: "50000" } as unknown as ArcusFill);
  assert.equal(fill.size, "0.01");
  assert.equal(fill.price, "50000");
});

test("vwap across partial fills", () => {
  const { size, price } = vwap([
    { size: "0.1", price: "2000" },
    { size: "0.3", price: "2010" },
  ]);
  assert.equal(size, "0.4");
  assert.equal(price, "2007.5");
});

const withdrawal = (fields: Partial<AccountTransferUpdate>): AccountTransferUpdate =>
  normaliseTransfer({ type: "WITHDRAWAL", amount: "5", status: "APPLIED", ...fields } as AccountTransferUpdate);

test("withdrawals correlate on the id, then fall back to amount", () => {
  assert.equal(matchesWithdrawal(withdrawal({ id: "w-1" }), "w-1"), true);
  assert.equal(matchesWithdrawal(withdrawal({ eventId: "w-1" }), "w-1"), true);
  // A stream event with an unrelated eventId: amount decides.
  assert.equal(matchesWithdrawal(withdrawal({ eventId: "evt-9" }), "w-1", 5_000_000n), true);
  assert.equal(matchesWithdrawal(withdrawal({ eventId: "evt-9" }), "w-1", 6_000_000n), false);
  // A row that names a different withdrawal never matches on amount.
  assert.equal(matchesWithdrawal(withdrawal({ withdrawalId: "w-2" }), "w-1", 5_000_000n), false);
  assert.equal(matchesWithdrawal(withdrawal({ type: "DEPOSIT", id: "w-1" }), "w-1"), false);
});
