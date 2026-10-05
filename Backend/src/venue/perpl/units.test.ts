import assert from "node:assert/strict";
import test from "node:test";

import {
  apiSideToDirection,
  assertPnlScaleSupported,
  assetToCns,
  chainTypeToDirection,
  cnsToAsset,
  lotsToSize6,
  pnsToPrice18,
  price18ToPns,
  size6ToLots,
  type CollateralScale,
} from "./units";

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

test("units: opening a position needs the asset at 6 decimals and the reader's sizeScale at 1e6", () => {
  assert.doesNotThrow(() => assertPnlScaleSupported(6, 1_000_000n));
  assert.throws(() => assertPnlScaleSupported(18, 10n ** 18n), /asset has 18 decimals/);
  assert.throws(() => assertPnlScaleSupported(6, 10_000_000n), /PerplReader sizes at 10000000/);
});

test("units: price and lot scaling round-trips for decimals 1, 2, 5 and 8", () => {
  for (const d of [1, 2, 5, 8]) {
    // Price: every Perpl integer price survives PNS -> 1e18 -> PNS exactly.
    for (const pns of [1n, 268707n, 853412n, 10n ** 12n]) {
      const price18 = pnsToPrice18(pns, d);
      assert.equal(price18, pns * 10n ** BigInt(18 - d), `price d=${d}`);
      assert.equal(price18ToPns(price18, d), pns, `price round-trip d=${d}`);
    }
    // Lots: lots -> size6 -> lots is exact while d <= 6 (size6 is coarser beyond).
    for (const lots of [1n, 14n, 21n, 123456n]) {
      const size6 = lotsToSize6(lots, d);
      if (d <= 6) assert.equal(size6ToLots(size6, d), lots, `lots round-trip d=${d}`);
      else assert.ok(size6ToLots(size6, d) <= lots, `lots never grow d=${d}`);
    }
  }
  // The recorded ETH fill: 14 lots at 3 dp = 0.014 ETH, 268707 at 2 dp = $2687.07.
  assert.equal(lotsToSize6(14n, 3), 14_000n);
  assert.equal(pnsToPrice18(268707n, 2), 268707n * 10n ** 16n);
});

test("units: API position side 1/2 and chain positionType 0/1 map to the same direction", () => {
  assert.equal(apiSideToDirection(1), chainTypeToDirection(0));
  assert.equal(apiSideToDirection(2), chainTypeToDirection(1));
  assert.equal(apiSideToDirection(1), "long");
  assert.equal(chainTypeToDirection(1), "short");
  assert.throws(() => apiSideToDirection(0));
  assert.throws(() => chainTypeToDirection(2));
});
