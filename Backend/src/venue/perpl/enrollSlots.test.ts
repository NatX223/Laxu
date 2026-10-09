import assert from "node:assert/strict";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { concat, hashDomain, hashStruct, hexToBytes, keccak256, recoverTypedDataAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { TypedData } from "./enrollment";
import { apiKeyVar, apiSecretVar, runEnrollSlots, type EnrollSlotsOptions } from "./enrollSlots";

/**
 * Offline: the enrollment flow against a local mock of Perpl's two endpoints,
 * answering in the documented shapes (integrations.md). Nothing reaches Perpl.
 */

const ORIGIN = "https://laxu.example";
const EVM_KEY = generatePrivateKey();
const WALLET = privateKeyToAccount(EVM_KEY);

// A payload in the documented shape: EIP-712 typed data whose message carries
// the human-readable `statement`, plus an opaque mac.
function typedDataFor(body: Record<string, unknown>): TypedData {
  return {
    domain: { name: "Perpl", version: "1", chainId: 10143 },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
      ],
      ApiKeyEnrollment: [
        { name: "statement", type: "string" },
        { name: "wallet", type: "address" },
        { name: "publicKey", type: "bytes32" },
        { name: "scopeMask", type: "uint32" },
        { name: "label", type: "string" },
        { name: "builderId", type: "uint8" },
        { name: "maxBuilderFeePer100K", type: "uint32" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ApiKeyEnrollment",
    message: {
      statement: `Authorize API key "${String(body.label)}" to read and trade on Perpl for ${String(body.address)}. It can never withdraw.`,
      wallet: body.address,
      publicKey: body.public_key,
      scopeMask: body.scope_mask,
      label: body.label,
      builderId: body.builder_id ?? 0,
      maxBuilderFeePer100K: body.max_builder_fee_per_100k ?? 0,
      nonce: `0x${randomBytes(32).toString("hex")}`,
    },
  };
}

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

async function mockPerpl(behaviour: { enrollStatus?: number[]; payloadStatus?: number; payloadBody?: unknown } = {}) {
  const seen: Seen[] = [];
  const tokens: string[] = [];
  const enrollStatuses = [...(behaviour.enrollStatus ?? [])];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/api-key/payload") {
        if (behaviour.payloadStatus) {
          res.statusCode = behaviour.payloadStatus;
          res.end(JSON.stringify(behaviour.payloadBody ?? { error: "origin not allowed" }));
          return;
        }
        res.end(JSON.stringify({ typed_data: typedDataFor(body), mac: "opaque-mac" }));
        return;
      }
      if (req.url === "/v1/api-key/enroll") {
        const status = enrollStatuses.shift() ?? 200;
        if (status !== 200) {
          res.statusCode = status;
          res.end(JSON.stringify({ error: `status ${status}` }));
          return;
        }
        const token = `tok_${randomBytes(12).toString("hex")}`;
        tokens.push(token);
        res.end(
          JSON.stringify({
            api_key: { api_key: token, address: body.address, scope_mask: 3, label: "x", ip_cidrs: [], origin: req.headers.origin, expires_at: 0, last_used_at: 0, created_at: Date.now() },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen, tokens, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function options(apiUrl: string, out: string, extra: Partial<EnrollSlotsOptions> = {}): EnrollSlotsOptions {
  return {
    slots: [1],
    scope: 3,
    label: "laxu-slot-{n}-v2",
    dryRun: false,
    verify: false,
    verifyOnly: false,
    out,
    origin: ORIGIN,
    apiUrl,
    wsUrl: "ws://127.0.0.1:1",
    chainId: 10143,
    ...extra,
  };
}

function rawEd25519PublicKey(hex: string) {
  const prefix = Buffer.from("302a300506032b6570032100", "hex"); // SPKI header for Ed25519
  return createPublicKey({ key: Buffer.concat([prefix, Buffer.from(hex.slice(2), "hex")]), format: "der", type: "spki" });
}

test("enroll: wallet signature recovers to the slot wallet, PoP verifies over the EIP-712 digest, key is raw 32-byte 0x-hex, Origin is set", async () => {
  const mock = await mockPerpl();
  const dir = mkdtempSync(join(tmpdir(), "enroll-"));
  try {
    const out = join(dir, "secrets", "slot-keys.json");
    const lines: string[] = [];
    const result = await runEnrollSlots(options(mock.url, out), { print: (l) => lines.push(l), evmKeyFor: () => EVM_KEY });
    assert.deepEqual(result, { ok: 1, failed: 0 });

    const payload = mock.seen.find((s) => s.path === "/v1/api-key/payload")!;
    const enroll = mock.seen.find((s) => s.path === "/v1/api-key/enroll")!;
    // (d) the Origin header on both calls
    assert.equal(payload.headers.origin, ORIGIN);
    assert.equal(enroll.headers.origin, ORIGIN);
    // (c) raw 32-byte public key, 0x-hex; documented payload fields, no ip_cidrs / expires_at
    assert.match(String(payload.body.public_key), /^0x[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(payload.body).sort(), ["address", "chain_id", "label", "public_key", "scope_mask"]);
    assert.equal(payload.body.label, "laxu-slot-1-v2");
    assert.equal(payload.body.address, WALLET.address);

    const typed = enroll.body.typed_data as TypedData;
    assert.equal(enroll.body.mac, "opaque-mac");
    const { EIP712Domain: _d, ...types } = typed.types;
    const signable = { domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message } as never;

    // (a) the wallet's EIP-712 signature recovers to the slot wallet
    const recovered = await recoverTypedDataAddress({ ...(signable as object), signature: enroll.body.signature as Hex } as never);
    assert.equal(recovered, WALLET.address);

    // (b) PoP: Ed25519 over keccak256(0x1901 || domainSeparator || hashStruct(message)), built here by hand
    const digest = keccak256(
      concat([
        "0x1901",
        hashDomain({ domain: typed.domain as never, types: typed.types as never }),
        hashStruct({ data: typed.message, primaryType: typed.primaryType, types } as never),
      ]),
    );
    const pop = Buffer.from(String(enroll.body.pop_signature).slice(2), "hex");
    assert.equal(pop.length, 64);
    assert.equal(verify(null, hexToBytes(digest), rawEd25519PublicKey(String(payload.body.public_key)), pop), true);

    // The secrets file holds the token and seed, owner-only.
    const file = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(file.env[apiKeyVar(1)], mock.tokens[0]);
    assert.match(file.env[apiSecretVar(1)], /^0x[0-9a-f]{64}$/);
    assert.equal(file.slots["1"].publicKey, payload.body.public_key);
    if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600);

    // (e) nothing secret in the output: not the token, the seed, nor the EVM key
    const printed = lines.join("\n");
    for (const secret of [mock.tokens[0], file.env[apiSecretVar(1)], file.env[apiSecretVar(1)].slice(2), EVM_KEY, EVM_KEY.slice(2)]) {
      assert.equal(printed.includes(secret), false);
    }
    assert.match(printed, /PERPL_API_KEY_1 {2}SECRET_SLOT_1_API/);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enroll: --dry-run requests the payload only and prints its statement", async () => {
  const mock = await mockPerpl();
  const dir = mkdtempSync(join(tmpdir(), "enroll-"));
  try {
    const lines: string[] = [];
    const result = await runEnrollSlots(options(mock.url, join(dir, "k.json"), { dryRun: true }), { print: (l) => lines.push(l), evmKeyFor: () => EVM_KEY });
    assert.deepEqual(result, { ok: 1, failed: 0 });
    assert.deepEqual(mock.seen.map((s) => s.path), ["/v1/api-key/payload"]);
    assert.match(lines.join("\n"), /statement: Authorize API key "laxu-slot-1-v2"/);
    assert.equal(lines.join("\n").includes("opaque-mac"), false);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enroll: builder flags pass through to the payload request", async () => {
  const mock = await mockPerpl();
  const dir = mkdtempSync(join(tmpdir(), "enroll-"));
  try {
    await runEnrollSlots(options(mock.url, join(dir, "k.json"), { dryRun: true, builderId: 7, maxBuilderFeePer100k: 0 }), {
      print: () => undefined,
      evmKeyFor: () => EVM_KEY,
    });
    assert.equal(mock.seen[0].body.builder_id, 7);
    assert.equal(mock.seen[0].body.max_builder_fee_per_100k, 0);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enroll: 409 retries with a FRESH key pair; 423 stops with a clear message", async () => {
  const conflict = await mockPerpl({ enrollStatus: [409] });
  const limit = await mockPerpl({ enrollStatus: [423] });
  const dir = mkdtempSync(join(tmpdir(), "enroll-"));
  try {
    await runEnrollSlots(options(conflict.url, join(dir, "a.json")), { print: () => undefined, evmKeyFor: () => EVM_KEY });
    const keys = conflict.seen.filter((s) => s.path === "/v1/api-key/payload").map((s) => s.body.public_key);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);

    const lines: string[] = [];
    const result = await runEnrollSlots(options(limit.url, join(dir, "b.json")), { print: (l) => lines.push(l), evmKeyFor: () => EVM_KEY });
    assert.deepEqual(result, { ok: 0, failed: 1 });
    assert.match(lines.join("\n"), /16 active API keys \(423\).*revoke/);
  } finally {
    await conflict.close();
    await limit.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enroll: a refused Origin is reported with Perpl's own text; a missing origin fails before any call", async () => {
  const mock = await mockPerpl({ payloadStatus: 403, payloadBody: { error: "origin not allowed" } });
  const dir = mkdtempSync(join(tmpdir(), "enroll-"));
  try {
    const lines: string[] = [];
    await runEnrollSlots(options(mock.url, join(dir, "k.json"), { dryRun: true }), { print: (l) => lines.push(l), evmKeyFor: () => EVM_KEY });
    assert.match(lines.join("\n"), /Origin \(HTTP 403\).*whitelisted.*"origin not allowed"/);

    await assert.rejects(
      runEnrollSlots(options(mock.url, join(dir, "k.json"), { origin: "" }), { print: () => undefined, evmKeyFor: () => EVM_KEY }),
      /PERPL_ENROLL_ORIGIN/,
    );
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enroll: --verify-only reports success/failure per slot from the secrets file, no secret printed", async () => {
  const mock = await mockPerpl();
  const dir = mkdtempSync(join(tmpdir(), "enroll-"));
  try {
    const out = join(dir, "k.json");
    await runEnrollSlots(options(mock.url, out), { print: () => undefined, evmKeyFor: () => EVM_KEY });
    const lines: string[] = [];
    const seenKeys: string[] = [];
    const result = await runEnrollSlots(options(mock.url, out, { verifyOnly: true }), {
      print: (l) => lines.push(l),
      evmKeyFor: () => EVM_KEY,
      verifyKey: async (credentials) => {
        seenKeys.push(credentials.apiKey);
        return { rest: true, ws: false };
      },
    });
    assert.deepEqual(result, { ok: 0, failed: 1 });
    assert.deepEqual(seenKeys, [mock.tokens[0]]);
    assert.deepEqual(lines, ["slot 1: signed read OK, trading-socket sign-in FAILED"]);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
