import assert from "node:assert/strict";
import test from "node:test";

import { marginFraction, maxLeverageFromInitialMargin } from "../venue/perpl/units";
import { bytes32ToSymbol, leverageLimits, marketIdFor, maxLeverage } from "./markets";

/// The stored row's limit for a Perpl `initial_margin` (max leverage in hundredths).
const limitFor = (initialMargin: number) => maxLeverage({ initialMarginFraction: marginFraction(initialMargin) });

test("maxLeverage reads Perpl initial_margin as max leverage in hundredths (testnet markets)", () => {
  // docs/perpl-findings.md#v-units-171: ETH 1200 = 12x; lv above it is clamped by Perpl.
  assert.equal(limitFor(1200), 12, "ETH");
  assert.equal(limitFor(1500), 15, "BTC");
  assert.equal(limitFor(1000), 10, "SOL");
  assert.equal(limitFor(300), 3, "MON / ZEC / LIT / NEAR");
  assert.equal(limitFor(500), 5, "PUMP");
  assert.equal(limitFor(2500), 20, "25x capped at Laxu's 20x");
  assert.equal(limitFor(1250), 12, "12.5x floors to 12");
});

test("marginFraction -> maxLeverage round-trips exactly for every integer initial_margin", () => {
  for (let im = 100; im <= 5000; im += 1) {
    assert.equal(limitFor(im), maxLeverageFromInitialMargin(im), `initial_margin ${im}`);
  }
});

test("maxLeverage never widens on a bad fraction", () => {
  assert.equal(maxLeverage({ initialMarginFraction: "0" }), 1);
  assert.equal(maxLeverage({ initialMarginFraction: "nope" }), 1);
  assert.equal(maxLeverage({ initialMarginFraction: "2" }), 1);
  assert.equal(maxLeverageFromInitialMargin(0), 1);
  assert.equal(maxLeverageFromInitialMargin(Number.NaN), 1);
});

test("leverageLimits: Perpl trades 24/7, one limit", () => {
  assert.deepEqual(leverageLimits({ initialMarginFraction: marginFraction(1200) }), { now: 12, inHours: 12, offHours: 12 });
});

test("market ids are readable bytes32 of the base asset", () => {
  const id = marketIdFor("eth");
  assert.equal(id, "0x4554480000000000000000000000000000000000000000000000000000000000");
  assert.equal(bytes32ToSymbol(id), "ETH");
});
