import assert from "node:assert/strict";
import test from "node:test";

import { SLOT1_FILLS, SLOT1_POSITIONS } from "./venueFillsMath.fixture";
import {
  amountHuman,
  matchFills,
  positionOrders,
  reachedBefore,
  realisedFunding,
  toVenueFill,
  txHashOf,
  type MatchKeys,
} from "./venueFillsMath";

// The two Laxu positions that shared slot 1 (values from the database).
const FIRST: MatchKeys = {
  accountId: "824",
  marketId: 32,
  pid: "4487821000705",
  knownOrderIds: ["4487821000704", "4487821000704", "4488370257920", "4488495497216"],
  fromMs: Date.parse("2026-10-05T18:59:51Z") - 5 * 60_000,
  toMs: Date.parse("2026-10-05T20:14:31Z") + 10 * 60_000,
};
const SECOND: MatchKeys = {
  accountId: "824",
  marketId: 32,
  pid: "4489210494977",
  knownOrderIds: ["4489210494992"],
  fromMs: Date.parse("2026-10-05T20:46:14Z") - 5 * 60_000,
  toMs: Date.parse("2026-10-06T07:24:01Z") + 10 * 60_000,
};

const ETH = { priceDecimals: 2, sizeDecimals: 3, cnsDecimals: 6 };

function fillsFor(keys: MatchKeys) {
  const orders = positionOrders(SLOT1_POSITIONS, keys);
  return { orders, ...matchFills(SLOT1_FILLS, keys, orders.orderIds) };
}

test("venue fills: position history by pid adds the close and reduce orders we never stored", () => {
  const { orders, fills, matchedBy } = fillsFor(FIRST);
  assert.equal(matchedBy, "order-ids");
  assert.deepEqual(
    [...orders.orderIds].sort(),
    ["4487821000704", "4488370257920", "4488495497216", "4488548253696", "4488816820224"].sort(),
  );
  // open, increase, two decreases, close -- newest first.
  assert.deepEqual(
    fills.map((f) => f.oid),
    [4488816820224, 4488548253696, 4488495497216, 4488370257920, 4487821000704],
  );
});

test("venue fills: two positions on the same slot never see each other's fills", () => {
  const first = new Set(fillsFor(FIRST).fills.map((f) => f.oid));
  const second = fillsFor(SECOND).fills.map((f) => f.oid);
  assert.deepEqual(second, [4497442340864, 4489210494992]);
  for (const oid of second) assert.equal(first.has(oid), false);
  // The probe trades (BTC, and the 1-lot ETH ones) belong to neither.
  const all = new Set([...first, ...second]);
  assert.equal(SLOT1_FILLS.filter((f) => !all.has(f.oid)).length, SLOT1_FILLS.length - 7);
});

test("venue fills: without a saved pid, the entry order's event names it", () => {
  const { orders, fills } = fillsFor({ ...SECOND, pid: null });
  assert.equal(orders.pid, "4489210494977");
  assert.equal(fills.length, 2);
});

test("venue fills: another account or market never matches, even with the same order id", () => {
  assert.equal(fillsFor({ ...FIRST, accountId: "841" }).fills.length, 0);
  assert.equal(fillsFor({ ...FIRST, marketId: 16 }).fills.length, 0);
});

test("venue fills: no ids at all falls back to account + market + time window", () => {
  const keys = { ...SECOND, pid: null, knownOrderIds: [] };
  const { fills, matchedBy } = fillsFor(keys);
  assert.equal(matchedBy, "time-window");
  for (const f of fills) assert.ok(f.at!.t! >= keys.fromMs && f.at!.t! <= keys.toMs && f.mkt === 32);
  assert.deepEqual(fills.map((f) => f.oid), [4497442340864, 4489210494992]);
});

test("venue fills: converts units with the market's decimals and keeps fees exact", () => {
  const entry = SLOT1_FILLS.find((f) => f.oid === 4489210494992)!;
  const fill = toVenueFill(entry, ETH);
  assert.equal(fill.priceHuman, "2715.92");
  assert.equal(fill.sizeHuman, "0.014");
  assert.equal(fill.feeHuman, "0.013118");
  assert.equal(fill.side, "buy");
  assert.equal(fill.action, "open");
  assert.equal(fill.liquiditySide, "taker");
  assert.equal(fill.builderFeeHuman, undefined, "bfa \"0\" is no builder fee");
  assert.equal(fill.txHash, "0xd2523953b7e911de657fef35bf797be2c90b7382146ea478ea0d29a6f057790e");
  assert.equal(fill.blockNumber, 68499916);
  assert.equal(fill.fillId, "68499916:1:36:4489210494992");
  assert.equal(fill.time, "2026-10-05T20:44:39.000Z");

  const close = toVenueFill(SLOT1_FILLS.find((f) => f.oid === 4497442340864)!, ETH);
  assert.equal(close.side, "sell");
  assert.equal(close.action, "close");
});

test("venue fills: a builder fee is shown separately, never added to the gross fee", () => {
  const fill = toVenueFill({ ...SLOT1_FILLS[0], f: "13292", bfa: "1200" }, ETH);
  assert.equal(fill.feeHuman, "0.013292");
  assert.equal(fill.builderFeeHuman, "0.0012");
});

test("venue fills: tx hashes are 0x-prefixed only when they are real 32-byte hashes", () => {
  assert.equal(txHashOf("AB".repeat(32)), `0x${"ab".repeat(32)}`);
  assert.equal(txHashOf(`0x${"cd".repeat(32)}`), `0x${"cd".repeat(32)}`);
  assert.equal(txHashOf(undefined), undefined);
  assert.equal(txHashOf("1234"), undefined);
  assert.equal(toVenueFill({ ...SLOT1_FILLS[0], at: { b: 1 } }, ETH).txHash, undefined);
});

test("venue fills: amounts and realised funding", () => {
  assert.equal(amountHuman("-935", 6), "-0.000935");
  assert.equal(amountHuman(undefined, 6), "0");
  assert.equal(amountHuman("not a number", 6), "0");
  // fnd on pid 4489210494977's close: -13300 -> paid 0.0133 AUSD.
  assert.equal(realisedFunding(fillsFor(SECOND).orders.events, 6), "-0.0133");
  // pid 4487821000705: -4240 on the increase.
  assert.equal(realisedFunding(fillsFor(FIRST).orders.events, 6), "-0.00424");
});

test("venue fills: the walk stops once a page reaches before the window", () => {
  assert.equal(reachedBefore(SLOT1_FILLS, SECOND.fromMs), true);
  assert.equal(reachedBefore(SLOT1_FILLS.slice(0, 3), SECOND.fromMs), false);
  assert.equal(reachedBefore([], SECOND.fromMs), false);
});
