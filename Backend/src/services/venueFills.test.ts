import assert from "node:assert/strict";
import test from "node:test";

import { HttpError, notFound } from "../lib/errors";
import { PerplApiError } from "../venue/perpl/rest";
import { cachedLoader, type VenueFillsResponse } from "./venueFills";

const answer = (n: number): VenueFillsResponse => ({
  source: "perpl",
  positionTokenAddress: "0xabc",
  accountId: "824",
  market: "ETH-USD",
  matchedBy: "order-ids",
  fills: [],
  realisedFunding: null,
  fetchedAt: `t${n}`,
  truncated: false,
});

test("venue fills cache: one upstream load per key while fresh, and concurrent callers share it", async () => {
  let calls = 0;
  const get = cachedLoader(async () => answer(++calls), 60_000);
  const [a, b] = await Promise.all([get("k"), get("k")]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  await get("k");
  assert.equal(calls, 1);
  await get("other");
  assert.equal(calls, 2);
});

test("venue fills cache: a 429 serves the last answer marked stale", async () => {
  let calls = 0;
  const get = cachedLoader(async () => {
    calls += 1;
    if (calls > 1) throw new PerplApiError("GET /v1/trading/fills rejected with HTTP 429", 429);
    return answer(calls);
  }, 0);
  assert.equal((await get("k")).stale, undefined);
  const stale = await get("k");
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, "t1");
});

test("venue fills cache: a 429 with nothing cached is a clear 503, other failures a 502", async () => {
  const limited = cachedLoader(async () => {
    throw new PerplApiError("rate limited", 429);
  });
  await assert.rejects(limited("k"), (e: unknown) => e instanceof HttpError && e.status === 503 && e.code === "VENUE_RATE_LIMITED");

  const down = cachedLoader(async () => {
    throw new Error("socket hang up");
  });
  await assert.rejects(down("k"), (e: unknown) => e instanceof HttpError && e.status === 502 && e.code === "VENUE_UNAVAILABLE");
});

test("venue fills cache: a 404 is passed through, never turned into stale data", async () => {
  let calls = 0;
  const get = cachedLoader(async () => {
    calls += 1;
    if (calls > 1) throw notFound("Position not found", "POSITION_NOT_FOUND");
    return answer(calls);
  }, 0);
  await get("k");
  await assert.rejects(get("k"), (e: unknown) => e instanceof HttpError && e.status === 404);
});
