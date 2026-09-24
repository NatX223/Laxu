import assert from "node:assert/strict";
import test from "node:test";

import {
  UnitsError,
  fromArcusPositionRow,
  fromPrice18,
  fromUsdg6,
  toFixedDecimals,
  toPrice18,
  toSize6,
  toUsdg6,
  usdg6ToArcusQuantums,
} from "./units";

const E18 = 10n ** 18n;

test("prices go on-chain at 1e18", () => {
  assert.equal(toPrice18("2000"), 2000n * E18);
  assert.equal(toPrice18("2744.78"), 274478n * 10n ** 16n);
  assert.equal(fromPrice18(2000n * E18), "2000");
});

test("size is base quantity x 1e6 and always positive", () => {
  assert.equal(toSize6("0.25"), 250000n);
  assert.equal(toSize6("-0.25"), 250000n);
  assert.equal(toSize6("0.01"), 10000n);
});

test("size x 1e6 with prices x 1e18 makes pnl land in USDG 6dp (spec worked example)", () => {
  const pnl = (toSize6("0.25") * (toPrice18("2200") - toPrice18("2000"))) / E18;
  assert.equal(pnl, 50_000_000n); // $50
});

test("USDG amounts are signed 6dp", () => {
  assert.equal(toUsdg6("500"), 500_000_000n);
  assert.equal(toUsdg6("-2"), -2_000_000n);
  assert.equal(fromUsdg6(-2_000_000n), "-2");
});

test("withdraw amounts are quote quantums, 1e9 per dollar", () => {
  assert.equal(usdg6ToArcusQuantums(toUsdg6("5")), 5_000_000_000n);
});

test("toFixedDecimals truncates to a fixed width", () => {
  assert.equal(toFixedDecimals(148n * 10n ** 16n, 18, 2), "1.48");
  assert.equal(toFixedDecimals(1_999_999n, 6, 2), "1.99");
  assert.equal(toFixedDecimals(-4_800n, 2, 2), "-48.00");
  assert.equal(toFixedDecimals(5n, 0, 1), "5.0");
});

test("fromArcusPositionRow parses a decimal row", () => {
  const parsed = fromArcusPositionRow(
    { size: "0.01", averageEntryPrice: "2000.5", cumulativeFunding: { sinceOpen: "-0.12" } },
    "2010",
  );
  assert.equal(parsed.size6, 10000n);
  assert.equal(parsed.entry18, 20005n * 10n ** 17n);
  assert.equal(parsed.mark18, 2010n * E18);
  assert.equal(parsed.funding6, -120000n);
});

test("fromArcusPositionRow refuses rows that look like engine quantums", () => {
  assert.throws(
    () => fromArcusPositionRow({ size: "50000000000", averageEntryPrice: "97500.5" }),
    UnitsError,
  );
});
