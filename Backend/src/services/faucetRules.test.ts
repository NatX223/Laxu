import { test } from "node:test";
import assert from "node:assert/strict";

import {
  IP_WINDOW_MS,
  ethTopUp,
  formatTruncated,
  isNonceError,
  nextClaimAt,
  normaliseIp,
} from "./faucetRules";

const HOUR = 60 * 60 * 1000;
const COOLDOWN = 24 * HOUR;
const now = new Date("2026-09-26T12:00:00Z");
const ago = (ms: number) => ({ createdAt: new Date(now.getTime() - ms) });

test("nextClaimAt: a first claim is allowed", () => {
  assert.equal(nextClaimAt([], [], COOLDOWN, now), null);
});

test("nextClaimAt: a claim inside the cooldown blocks until it expires", () => {
  const next = nextClaimAt([ago(2 * HOUR)], [ago(2 * HOUR)], COOLDOWN, now);
  assert.equal(next?.toISOString(), new Date(now.getTime() + 22 * HOUR).toISOString());
});

test("nextClaimAt: a claim older than the cooldown no longer blocks", () => {
  assert.equal(nextClaimAt([ago(25 * HOUR)], [], COOLDOWN, now), null);
});

test("nextClaimAt: the cooldown follows the user's LATEST claim", () => {
  const next = nextClaimAt([ago(20 * HOUR), ago(1 * HOUR)], [], COOLDOWN, now);
  assert.equal(next?.getTime(), now.getTime() + 23 * HOUR);
});

test("nextClaimAt: two claims from an IP still allow a third", () => {
  assert.equal(nextClaimAt([], [ago(1 * HOUR), ago(2 * HOUR)], COOLDOWN, now), null);
});

test("nextClaimAt: a fourth claim from one IP waits for the oldest of the last three", () => {
  const next = nextClaimAt([], [ago(1 * HOUR), ago(5 * HOUR), ago(3 * HOUR)], COOLDOWN, now);
  assert.equal(next?.getTime(), now.getTime() - 5 * HOUR + IP_WINDOW_MS);
});

test("nextClaimAt: with both limits hit, the later one wins", () => {
  const next = nextClaimAt([ago(1 * HOUR)], [ago(1 * HOUR), ago(5 * HOUR), ago(10 * HOUR)], COOLDOWN, now);
  assert.equal(next?.getTime(), now.getTime() + 23 * HOUR);
});

test("ethTopUp: tops UP TO the target", () => {
  assert.deepEqual(ethTopUp(500n, 120n, 10_000n, 2_000n), { kind: "send", amount: 380n });
});

test("ethTopUp: nothing when the wallet already holds the target", () => {
  assert.deepEqual(ethTopUp(500n, 500n, 10_000n, 2_000n), { kind: "none" });
  assert.deepEqual(ethTopUp(500n, 900n, 10_000n, 2_000n), { kind: "none" });
});

test("ethTopUp: skipped when the faucet would drop under its reserve", () => {
  assert.deepEqual(ethTopUp(500n, 0n, 2_400n, 2_000n), { kind: "skip", amount: 500n });
  // exactly at the reserve afterwards is still fine
  assert.deepEqual(ethTopUp(500n, 0n, 2_500n, 2_000n), { kind: "send", amount: 500n });
});

test("isNonceError: recognises nonce and replacement errors anywhere in the cause chain", () => {
  assert.equal(isNonceError(new Error("nonce too low: next nonce 5, tx nonce 4")), true);
  assert.equal(isNonceError(new Error("replacement transaction underpriced")), true);
  const wrapped = new Error("Transaction failed", { cause: new Error("Nonce too low") });
  assert.equal(isNonceError(wrapped), true);
  const details = Object.assign(new Error("An RPC error"), { details: "replacement underpriced" });
  assert.equal(isNonceError(details), true);
  assert.equal(isNonceError(new Error("execution reverted")), false);
  assert.equal(isNonceError(new Error("insufficient funds for gas")), false);
});

test("normaliseIp: strips the IPv4-mapped prefix", () => {
  assert.equal(normaliseIp("::ffff:10.0.0.1"), "10.0.0.1");
  assert.equal(normaliseIp("2001:db8::1"), "2001:db8::1");
  assert.equal(normaliseIp(undefined), null);
});

test("formatTruncated: truncates rather than rounds", () => {
  assert.equal(formatTruncated(250_009_999n, 6, 2), "250.00");
  assert.equal(formatTruncated(310_999_000_000_000n, 18, 6), "0.000310");
  assert.equal(formatTruncated(0n, 18, 6), "0.000000");
});
