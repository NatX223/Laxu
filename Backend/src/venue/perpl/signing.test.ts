import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import { restCanonical, sha256Hex, signedHeaders, signInFrame, wsSignInCanonical } from "./signing";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const BASE64URL_NO_PAD = /^[A-Za-z0-9_-]+$/;

test("signing: REST canonical string matches the documented field order and base64url-no-padding signature", () => {
  // authentication.md: chainId, METHOD, request-target, timestamp ms, nonce, sha256 hex of the raw body.
  const body = '{"d":[{"rq":11}]}';
  const canonical = restCanonical({
    chainId: 10143,
    method: "post",
    target: "/v1/trading/orders",
    timestampMs: "1791217675000",
    nonce: "bm9uY2U",
    body,
  });
  assert.equal(
    canonical,
    ["10143", "POST", "/v1/trading/orders", "1791217675000", "bm9uY2U", createHash("sha256").update(body).digest("hex")].join("\n"),
  );
  // An empty body hashes "" -- not omitted.
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

  const headers = signedHeaders({
    key: privateKey,
    apiKey: "tok",
    chainId: 10143,
    method: "GET",
    target: "/v1/trading/wallet",
    body: "",
    now: 1791217675000,
  });
  assert.deepEqual(Object.keys(headers).sort(), ["X-API-Key", "X-API-Nonce", "X-API-Signature", "X-API-Timestamp"]);
  assert.equal(headers["X-API-Timestamp"], "1791217675000");
  assert.match(headers["X-API-Nonce"], BASE64URL_NO_PAD);
  assert.match(headers["X-API-Signature"], BASE64URL_NO_PAD, "base64url, no '=' padding");

  const signature = Buffer.from(headers["X-API-Signature"], "base64url");
  assert.equal(signature.length, 64, "raw 64-byte Ed25519 signature");
  const signed = restCanonical({
    chainId: 10143,
    method: "GET",
    target: "/v1/trading/wallet",
    timestampMs: headers["X-API-Timestamp"],
    nonce: headers["X-API-Nonce"],
    body: "",
  });
  assert.ok(verify(null, Buffer.from(signed), publicKey, signature), "verifies against the canonical string");
});

test("signing: WS sign-in canonical string uses the trading-ws-signin tag", () => {
  assert.equal(
    wsSignInCanonical({ chainId: 10143, timestampMs: "1791217110068", nonce: "abc" }),
    "10143\ntrading-ws-signin\n1791217110068\nabc",
  );
  const frame = signInFrame({ key: privateKey, apiKey: "tok", chainId: 10143, now: 1791217110068 });
  assert.equal(frame.mt, 29);
  assert.equal(frame.chain_id, 10143);
  assert.equal(frame.timestamp, "1791217110068");
  assert.match(frame.signature, BASE64URL_NO_PAD);
  const canonical = wsSignInCanonical({ chainId: 10143, timestampMs: frame.timestamp, nonce: frame.nonce });
  assert.ok(verify(null, Buffer.from(canonical), publicKey, Buffer.from(frame.signature, "base64url")));
});
