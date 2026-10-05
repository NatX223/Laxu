import assert from "node:assert/strict";
import test from "node:test";

import { redact } from "./recorder";

test("recorder: redacts API keys, signatures, nonces and X-API-* headers at any depth", () => {
  const out = redact({
    mt: 29,
    chain_id: 10143,
    api_key: "tok",
    timestamp: "1",
    nonce: "n",
    signature: "s",
    headers: { "X-API-Key": "tok", "X-API-Signature": "s", "Content-Type": "application/json" },
    d: [{ rq: 7, secret: "x" }],
  });
  assert.deepEqual(out, {
    mt: 29,
    chain_id: 10143,
    api_key: "<redacted>",
    timestamp: "1",
    nonce: "<redacted>",
    signature: "<redacted>",
    headers: { "X-API-Key": "<redacted>", "X-API-Signature": "<redacted>", "Content-Type": "application/json" },
    d: [{ rq: 7, secret: "<redacted>" }],
  });
});
