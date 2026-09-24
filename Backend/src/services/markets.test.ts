import assert from "node:assert/strict";
import test from "node:test";

import { bytes32ToSymbol, leverageLimits, marketIdFor, maxLeverage, tradingHoursOf } from "./markets";

const lev = (initialMarginFraction: string, offHoursInitialMarginFraction = initialMarginFraction) => ({
  inHours: maxLeverage({ initialMarginFraction, offHoursInitialMarginFraction, isOutsideRth: false }),
  offHours: maxLeverage({ initialMarginFraction, offHoursInitialMarginFraction, isOutsideRth: true }),
});

// Fractions as Arcus reports them today.
test("maxLeverage matches the spec table", () => {
  assert.deepEqual(lev("0.025"), { inHours: 20, offHours: 20 }, "BTC 40x capped at 20");
  assert.deepEqual(lev("0.04"), { inHours: 20, offHours: 20 }, "ETH 25x capped at 20 (1/0.04 float)");
  assert.deepEqual(lev("0.2"), { inHours: 5, offHours: 5 }, "DYDX");
  assert.deepEqual(lev("0.1", "0.15"), { inHours: 10, offHours: 6 }, "AMD");
  assert.deepEqual(lev("0.02", "0.03"), { inHours: 20, offHours: 20 }, "SPY 50x/33x");
  assert.deepEqual(lev("0.04", "0.06"), { inHours: 20, offHours: 16 }, "GLD 25x/16x");
  assert.deepEqual(lev("0.05", "0.075"), { inHours: 20, offHours: 13 }, "NVDA 20x/13x");
  assert.deepEqual(lev("0.2", "0.3"), { inHours: 5, offHours: 3 }, "COIN 5x/3x");
});

test("maxLeverage never widens on a bad fraction", () => {
  assert.equal(lev("0").inHours, 1);
  assert.equal(lev("nope").inHours, 1);
  assert.equal(lev("2").inHours, 1);
});

test("leverageLimits reports the limit that applies now", () => {
  const amd = { initialMarginFraction: "0.1", offHoursInitialMarginFraction: "0.15" };
  assert.deepEqual(leverageLimits({ ...amd, isOutsideRth: true }), { now: 6, inHours: 10, offHours: 6 });
  assert.deepEqual(leverageLimits({ ...amd, isOutsideRth: false }), { now: 10, inHours: 10, offHours: 6 });
});

test("market ids are readable bytes32 of the base asset", () => {
  const id = marketIdFor("eth");
  assert.equal(id, "0x4554480000000000000000000000000000000000000000000000000000000000");
  assert.equal(bytes32ToSymbol(id), "ETH");
});

test("tradingHoursOf converts Arcus seconds-of-day", () => {
  assert.deepEqual(
    tradingHoursOf({ startSecondsOfDay: 14400, endSecondsOfDay: 72000, timezone: "America/New_York" }),
    { start: "04:00", end: "20:00", timezone: "America/New_York" },
  );
  assert.equal(tradingHoursOf(null), null);
});
