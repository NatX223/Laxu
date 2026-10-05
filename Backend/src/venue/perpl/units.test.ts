import assert from "node:assert/strict";
import test from "node:test";

import { assertSizeScaleSupported, assetToCns, cnsToAsset, type CollateralScale } from "./units";

const scale = (cnsDecimals: number, assetDecimals: number): CollateralScale => ({ cnsDecimals, assetDecimals });

test("units: converts CNS to asset and back for collateralDecimals 6, 7 and 18 against token decimals 6 and 18", () => {
  // $12.345678 in each scale.
  const human = { int: 12n, frac6: 345678n };
  const inScale = (d: number) => human.int * 10n ** BigInt(d) + human.frac6 * 10n ** BigInt(d - 6);

  for (const cnsDecimals of [6, 7, 18]) {
    for (const assetDecimals of [6, 18]) {
      const s = scale(cnsDecimals, assetDecimals);
      const cns = inScale(cnsDecimals);
      const asset = inScale(assetDecimals);
      assert.equal(cnsToAsset(cns, s), asset, `CNS->asset ${cnsDecimals}->${assetDecimals}`);
      assert.equal(assetToCns(asset, s), cns, `asset->CNS ${assetDecimals}->${cnsDecimals}`);
    }
  }
});

test("units: CNS -> asset floors when the asset has fewer decimals", () => {
  // 7-decimal CNS with a dust digit the 6-decimal asset cannot hold.
  assert.equal(cnsToAsset(100_000_009n, scale(7, 6)), 10_000_000n);
  // 18 -> 6: anything below 1e-6 is dropped, never rounded up.
  assert.equal(cnsToAsset(999_999_999_999n, scale(18, 6)), 0n);
  assert.equal(cnsToAsset(1_000_000_000_001n, scale(18, 6)), 1n);
});

test("units: asset -> CNS floors when the collateral has fewer decimals", () => {
  // A deposit never asks the exchange for more than the asset amount covers.
  assert.equal(assetToCns(1_234_567_890_123_456_789n, scale(6, 18)), 1_234_567n);
  assert.equal(assetToCns(999_999_999_999n, scale(6, 18)), 0n);
});

test("units: CNS -> asset scales up exactly when the asset has more decimals", () => {
  assert.equal(cnsToAsset(1n, scale(6, 18)), 10n ** 12n);
  assert.equal(assetToCns(1n, scale(7, 6)), 10n);
});

test("units: opening a position needs collateralDecimals and asset decimals at 6 (deployed PerplReader.toSize)", () => {
  assert.doesNotThrow(() => assertSizeScaleSupported(scale(6, 6)));
  assert.throws(() => assertSizeScaleSupported(scale(7, 6)), /collateralDecimals/);
  assert.throws(() => assertSizeScaleSupported(scale(6, 18)), /asset has 18 decimals/);
});
