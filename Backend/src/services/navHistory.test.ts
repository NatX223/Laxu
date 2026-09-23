import assert from "node:assert/strict";
import test from "node:test";

import { downsample, navPerToken } from "./navHistory";

const E18 = 10n ** 18n;

test("navPerToken is fixed width and floors", () => {
  assert.equal(navPerToken(1n, 1n), "1.000000");
  assert.equal(navPerToken(1_042_100n * 10n ** 12n, E18), "1.042100");
  // 2/3 floors rather than rounding up to ...667.
  assert.equal(navPerToken(2n * E18, 3n * E18), "0.666666");
  assert.equal(navPerToken(0n, E18), "0.000000");
  assert.equal(navPerToken(12_345n * E18, E18), "12345.000000");
});

test("downsample keeps first and last, and returns ~limit points", () => {
  const items = Array.from({ length: 1000 }, (_, i) => i);
  const picked = downsample(items, 50);
  assert.equal(picked.length, 50);
  assert.equal(picked[0], 0);
  assert.equal(picked[picked.length - 1], 999);
  for (let i = 1; i < picked.length; i += 1) assert.ok(picked[i] > picked[i - 1]);
});

test("downsample leaves short series alone", () => {
  assert.deepEqual(downsample([1, 2, 3], 50), [1, 2, 3]);
});
