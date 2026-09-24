import assert from "node:assert/strict";
import test from "node:test";

import { toPrice18, toSize6, toUsdg6 } from "../lib/units";
import { belowMinimums, buyInAddedSize, floorSize6ToStep, marginUsed6, redeemClosedSize } from "./sizing";

const grid = { stepSize: "0.001", minOrderSize: "0.001", minOrderNotional: "10" };

test("buy-in adds the buyer's proportional share of the size", () => {
  // $740 position, 1.25 ETH; a $148 buy-in is 20% of it -> 0.25 ETH.
  const added = buyInAddedSize({
    assets6: toUsdg6("148"),
    size6: toSize6("1.25"),
    totalAssets6: toUsdg6("740"),
    leverage: 5,
    mark18: toPrice18("2192"),
    grid,
  });
  assert.equal(added, toSize6("0.25"));
});

test("buy-in is capped at assets x L_set / mark when the position has lost value", () => {
  // Down to $300 on 1.25 ETH @ $2000 -> effective leverage 8.3x > 5x.
  const added = buyInAddedSize({
    assets6: toUsdg6("100"),
    size6: toSize6("1.25"),
    totalAssets6: toUsdg6("300"),
    leverage: 5,
    mark18: toPrice18("2000"),
    grid,
  });
  // proportional 0.4166 ETH; cap = 100 x 5 / 2000 = 0.25 ETH.
  assert.equal(added, toSize6("0.25"));
});

test("buy-in rounds down to the step and falls back to margin-only below minimums", () => {
  const added = buyInAddedSize({
    assets6: toUsdg6("3"),
    size6: toSize6("1.25"),
    totalAssets6: toUsdg6("740"),
    leverage: 5,
    mark18: toPrice18("2192"),
    grid,
  });
  // 0.005067 ETH floors to 0.005 = $10.96 notional -> placed.
  assert.equal(added, toSize6("0.005"));

  const tiny = buyInAddedSize({
    assets6: toUsdg6("1"),
    size6: toSize6("1.25"),
    totalAssets6: toUsdg6("740"),
    leverage: 5,
    mark18: toPrice18("2192"),
    grid,
  });
  assert.equal(tiny, 0n);
});

test("redeem reduces by shares/supply of the size, capped at the leg", () => {
  const closed = redeemClosedSize({
    shares: toUsdg6("250"),
    supply: toUsdg6("500"),
    size6: toSize6("1.25"),
    legSize6: toSize6("1.25"),
    mark18: toPrice18("2192"),
    grid,
  });
  assert.equal(closed, toSize6("0.625"));

  const capped = redeemClosedSize({
    shares: toUsdg6("250"),
    supply: toUsdg6("500"),
    size6: toSize6("1.25"),
    legSize6: toSize6("0.5"),
    mark18: toPrice18("2192"),
    grid,
  });
  assert.equal(capped, toSize6("0.5"));
});

test("tiny redeems come out of the buffer; a full exit always closes the leg", () => {
  const tiny = redeemClosedSize({
    shares: 1_000_000n,
    supply: toUsdg6("500"),
    size6: toSize6("1.25"),
    legSize6: toSize6("1.25"),
    mark18: toPrice18("2192"),
    grid,
  });
  assert.equal(tiny, 0n);

  const all = redeemClosedSize({
    shares: toUsdg6("1"),
    supply: toUsdg6("1"),
    size6: toSize6("0.002"),
    legSize6: toSize6("0.002"),
    mark18: toPrice18("2000"),
    grid,
  });
  assert.equal(all, toSize6("0.002"));
});

test("grid helpers", () => {
  assert.equal(floorSize6ToStep(1_234_567n, "0.01"), 1_230_000n);
  assert.equal(floorSize6ToStep(1_234_567n, "0.0000001"), 1_234_567n);
  assert.equal(belowMinimums(toSize6("0.004"), toPrice18("2000"), grid), true); // $8 notional
  assert.equal(marginUsed6(toSize6("0.25"), toPrice18("2192"), 5), toUsdg6("109.6"));
});
