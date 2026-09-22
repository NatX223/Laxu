import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../lib/canonicalJson";
import { applyBps, ceilToStep, divideExact, floorToStep, formatDecimal, fromBaseUnits, parseDecimal, toBaseUnits } from "../lib/decimal";
import { loadEd25519PrivateKey, publicKeyHex } from "./ed25519";
import { OrderSignOp, OrderSignSide, OrderSignTif, signArcusRequest } from "./signing";

/**
 * Run with: node --test --import tsx src/**\/*.test.ts
 * or simply: npx tsc && node --test dist/
 *
 * These cover the parts where a silent mistake produces a valid-looking
 * signature over the wrong bytes -- which Arcus rejects with a bare 401 and no
 * indication of which field was wrong.
 */

function freshKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { pem, key: loadEd25519PrivateKey(pem) };
}

test("canonicalJson sorts keys at every level and emits no whitespace", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 4, c: 3 } }),
    '{"a":{"c":3,"d":4},"b":1}',
  );
  assert.equal(canonicalJson({ z: [3, 1], a: "x" }), '{"a":"x","z":[3,1]}');
  // undefined fields drop out rather than serialising as null.
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  // bigints serialise as bare integers, not strings.
  assert.equal(canonicalJson({ ct: 1712345678000000000n }), '{"ct":1712345678000000000}');
});

test("ed25519 accepts a PEM and a raw 32-byte seed as the same key", () => {
  const { pem, key } = freshKey();
  const seed = key.export({ format: "jwk" }).d as string;
  const seedHex = Buffer.from(seed, "base64url").toString("hex");

  assert.equal(publicKeyHex(loadEd25519PrivateKey(pem)), publicKeyHex(loadEd25519PrivateKey(seedHex)));
  assert.equal(publicKeyHex(key).length, 64);
});

test("typed scheme signs the canonical payload itself, with ct as the timestamp", () => {
  const { pem, key } = freshKey();
  const apiKey = publicKeyHex(key);
  const ct = 1712345678000000000n;

  const signed = signArcusRequest({
    scheme: "typed",
    apiKey,
    secret: pem,
    payload: {
      // Deliberately out of order and mixed-case, to prove both are normalised.
      v: 1,
      t: OrderSignTif.IOC,
      s: OrderSignSide.Buy,
      r: 0,
      q: 100n,
      p: 5000050n,
      op: OrderSignOp.Place,
      m: 1,
      g: 4102444800000000000n,
      ct,
      c: "abc-123",
      ad: "0xAbCdEf0000000000000000000000000000000001",
    },
  });

  assert.equal(
    signed.message,
    '{"ad":"0xabcdef0000000000000000000000000000000001","ai":undefined'.replace(',"ai":undefined', "") +
      ',"c":"abc-123","ct":1712345678000000000,"g":4102444800000000000,"m":1,"op":1,"p":5000050,"q":100,"r":0,"s":0,"t":2,"v":1}',
  );
  // The timestamp sent must be the `ct` inside the payload, not a fresh clock read.
  assert.equal(signed.timestamp, ct.toString());
  assert.equal(signed.signature.length, 128);
  assert.ok(
    verify(null, Buffer.from(signed.message), loadEd25519PrivateKey(pem), Buffer.from(signed.signature, "hex")),
  );
});

test("legacy scheme concatenates timestamp + action + canonical body with no delimiters", () => {
  const { pem, key } = freshKey();
  const timestamp = 1712345678000000000n;

  const signed = signArcusRequest({
    scheme: "legacy",
    apiKey: publicKeyHex(key),
    secret: pem,
    action: "adjustIsolatedMargin",
    timestamp,
    body: { marketId: 1, amount: "100", address: "0xabc", accountIndex: 3 },
  });

  assert.equal(
    signed.message,
    '1712345678000000000adjustIsolatedMargin{"accountIndex":3,"address":"0xabc","amount":"100","marketId":1}',
  );
  assert.ok(
    verify(null, Buffer.from(signed.message), loadEd25519PrivateKey(pem), Buffer.from(signed.signature, "hex")),
  );
});

test("legacy scheme with no body signs just timestamp + action", () => {
  const { pem, key } = freshKey();
  const signed = signArcusRequest({
    scheme: "legacy",
    apiKey: publicKeyHex(key),
    secret: pem,
    action: "cancelAllOrders",
    timestamp: 1n,
  });
  assert.equal(signed.message, "1cancelAllOrders");
});

test("ticks and quantums divide exactly or throw", () => {
  assert.equal(divideExact("50000.5", "0.1"), 500005n);
  assert.equal(divideExact("0.01", "0.001"), 10n);
  assert.equal(divideExact("100", "1"), 100n);
  // A price off the grid must not be silently rounded into a signature.
  assert.throws(() => divideExact("50000.55", "0.1"), /not an exact multiple/);
});

test("step rounding goes the safe way for each side of a protective bound", () => {
  assert.equal(floorToStep("1.2345", "0.01"), "1.23");
  assert.equal(ceilToStep("1.2345", "0.01"), "1.24");
  // Already on the grid: ceil must not push it a step further out.
  assert.equal(ceilToStep("1.23", "0.01"), "1.23");
});

test("basis-point bounds move the right way", () => {
  assert.equal(applyBps("100", 900, 2), "109");
  assert.equal(applyBps("100", -900, 2), "91");
  // Truncates rather than rounds at the requested scale.
  assert.equal(applyBps("100.5", 250, 2), "103.01");
});

test("base-unit conversion is lossless in both directions at 18 decimals", () => {
  assert.equal(toBaseUnits("1.5", 18), 1_500_000_000_000_000_000n);
  assert.equal(fromBaseUnits(1_500_000_000_000_000_000n, 18), "1.5");
  assert.equal(fromBaseUnits(0n, 18), "0");
  // Anything below the asset's precision truncates rather than rounding up.
  assert.equal(toBaseUnits("1.9999", 2), 199n);
});

test("formatDecimal round-trips through parseDecimal", () => {
  for (const value of ["0", "1", "-1.5", "0.000001", "123456789.987654321"]) {
    assert.equal(formatDecimal(parseDecimal(value)), value);
  }
});
