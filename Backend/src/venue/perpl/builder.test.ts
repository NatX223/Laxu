import assert from "node:assert/strict";
import test from "node:test";

import { toVenueFill } from "../../services/venueFillsMath";
import { builderConfigFrom, builderFeeField, chargedFeePer100k, per100kToPct } from "./builder";

const on = (fee: string, max = "100", id = "7") => ({
  PERPL_BUILDER_ENABLED: "true",
  PERPL_BUILDER_ID: id,
  PERPL_MAX_BUILDER_FEE_PER_100K: max,
  PERPL_BUILDER_FEE_PER_100K: fee,
});

test("builder: the default (nothing set) is off, fee 0, and adds nothing to an order", () => {
  const cfg = builderConfigFrom({});
  assert.deepEqual(cfg, { enabled: false, builderId: null, maxFeePer100k: 0, feePer100k: 0 });
  assert.deepEqual(builderFeeField(cfg), {});
  assert.equal(chargedFeePer100k(cfg), 0);
});

test("builder: never sends bf while the flag is off, whatever the fee says", () => {
  const cfg = builderConfigFrom({ ...on("50"), PERPL_BUILDER_ENABLED: "false" });
  assert.deepEqual(builderFeeField(cfg), {});
  assert.equal(chargedFeePer100k(cfg), 0);
});

test("builder: enabled with fee 0 is attribution only -- no bf", () => {
  assert.deepEqual(builderFeeField(builderConfigFrom(on("0", "0"))), {});
});

test("builder: enabled with a fee sends exactly that bf", () => {
  const cfg = builderConfigFrom(on("50"));
  assert.deepEqual(builderFeeField(cfg), { bf: 50 });
  assert.equal(per100kToPct(chargedFeePer100k(cfg)), 0.05);
  // An order spread with it carries the field; one without does not.
  assert.equal("bf" in { rq: 1, ...builderFeeField(cfg) }, true);
  assert.equal("bf" in { rq: 1, ...builderFeeField(builderConfigFrom({})) }, false);
});

test("builder: never above the ceiling -- boot refuses fee > ceiling, and the field clamps defensively", () => {
  assert.throws(() => builderConfigFrom(on("60", "50")), /above the enrolled ceiling/);
  assert.deepEqual(builderFeeField({ enabled: true, builderId: 7, maxFeePer100k: 10, feePer100k: 30 }), { bf: 10 });
});

test("builder: boot validation of id, ceiling and number format", () => {
  assert.throws(() => builderConfigFrom(on("0", "0", "")), /PERPL_BUILDER_ID in 1\.\.255/);
  assert.throws(() => builderConfigFrom(on("0", "0", "0")), /1\.\.255/);
  assert.throws(() => builderConfigFrom(on("0", "0", "256")), /1\.\.255/);
  assert.throws(() => builderConfigFrom(on("0", "101")), /at most 100/);
  assert.throws(() => builderConfigFrom(on("1.5")), /whole number/);
  assert.throws(() => builderConfigFrom({ PERPL_BUILDER_FEE_PER_100K: "-1" }), /whole number/);
  assert.doesNotThrow(() => builderConfigFrom(on("100", "100", "255")));
  // Off: an unset id is fine, and so is a value that would be invalid if on.
  assert.doesNotThrow(() => builderConfigFrom({ PERPL_BUILDER_ENABLED: "false", PERPL_MAX_BUILDER_FEE_PER_100K: "500" }));
});

test("builder: bfa on a fill is the builder part of the gross fee, parsed apart", () => {
  const fill = { at: { b: 1, t: 1, tx: 0, l: 0 }, mkt: 32, acc: 824, oid: 9, t: 1, l: 2, p: 271592, s: 14, f: "13118", bfa: "3800" };
  const out = toVenueFill(fill, { priceDecimals: 2, sizeDecimals: 3, cnsDecimals: 6 });
  assert.equal(out.feeHuman, "0.013118");
  assert.equal(out.builderFeeHuman, "0.0038");
});
