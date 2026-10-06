import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { settleOrderEvents } from "./perpl/tradingWs";
import type { ApiOrder } from "./perpl/types";
import { decideByLots, lastExecBlockFor, nextRequestId } from "./requests";

test("requests: rq is max(lastRequestId, lfr) + 1 and lb = head + order_ttl_blocks", () => {
  assert.equal(nextRequestId({ lfr: 11n, lastRequestId: 9n, handedOut: 0n }), 12n, "the exchange's lfr is ahead");
  assert.equal(nextRequestId({ lfr: 2n, lastRequestId: 15n, handedOut: 0n }), 16n, "our saved counter is ahead");
  assert.equal(nextRequestId({ lfr: 2n, lastRequestId: 15n, handedOut: 17n }), 18n, "two flows in one process");
  assert.equal(nextRequestId({ lfr: 0n, lastRequestId: 0n, handedOut: 0n }), 1n, "a fresh account");
  // ETH order_ttl_blocks = 20 (fixtures/perpl/context.testnet.json); a TTL of 0 still gives head + 1.
  assert.equal(lastExecBlockFor(68448907n, 20), 68448927n);
  assert.equal(lastExecBlockFor(100n, 0), 101n);
});

const base = { lastExecBlock: 1_000n, size6Before: 14_000n, entry18Before: 2687_07n * 10n ** 16n, mark18Now: 2694_21n * 10n ** 16n };

test("findOrderOutcome: pending until the chain passes lb, then not_placed (size unchanged) or filled by the lot delta", () => {
  // Spec 03 names this "pending before lb, not_placed after lb, found when in history"; the
  // history lookup was replaced by the on-chain lot rule (docs/perpl-findings.md#v-adapter-216).
  const unchanged = { ...base, size6Now: 14_000n, entry18Now: base.entry18Before };
  assert.equal(decideByLots({ ...unchanged, chainBlock: 999n }), "pending", "before lb");
  assert.equal(decideByLots({ ...unchanged, chainBlock: 1_000n }), "pending", "AT lb the order can still execute");
  assert.equal(decideByLots({ ...unchanged, chainBlock: 1_001n }), "not_placed", "past lb, nothing moved");

  // The recorded increase: 14 -> 21 lots, entry 2687.07 -> 2689.77 (weighted) => 7 lots at 2695.17.
  const grew = decideByLots({ ...base, chainBlock: 1_001n, size6Now: 21_000n, entry18Now: 2689_77n * 10n ** 16n });
  assert.notEqual(typeof grew, "string");
  const g = grew as Exclude<typeof grew, string>;
  assert.equal(g.filledSize6, 7_000n);
  assert.equal(g.grew, true);
  assert.equal(g.avgPrice18, 2695_17n * 10n ** 16n);

  // A reduce: priced at the on-chain mark (the chain has no exit price).
  const shrank = decideByLots({ ...base, chainBlock: 1_001n, size6Now: 4_000n, entry18Now: base.entry18Before });
  const s = shrank as Exclude<typeof shrank, string>;
  assert.equal(s.filledSize6, 10_000n);
  assert.equal(s.grew, false);
  assert.equal(s.avgPrice18, base.mark18Now);
});

test("t:6: a successful add-margin reports only a late failure, so depositCNS decides (recorded frames)", () => {
  const recorded = readFileSync(join(process.cwd(), "fixtures", "perpl", "frames.add-margin.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).frame as Record<string, unknown>);
  const rq = (recorded.find((f) => f.mt === 22) as { rq: number }).rq;
  // The collateral landed: a position event with sr:6 and c = +5,000,000 ...
  const applied = recorded.find((f) => f.mt === 27) as { d: Array<{ e?: Array<{ sr: number; c: string }> }> };
  assert.deepEqual(applied.d[0].e?.map((e) => [e.sr, e.c]), [[6, "5000000"]]);
  // ... yet the only order status for the rq is a failure.
  const events = recorded.filter((f) => f.mt === 24).flatMap((f) => (f.d as ApiOrder[]).filter((o) => o.rq === rq));
  assert.deepEqual(events.map((o) => [o.st, o.sr]), [[7, 32]]);
  assert.equal(settleOrderEvents(events, "instant").order?.st, 7, "the socket alone would call it failed");
});

test("market orders carry an explicit limit at the slippage bound (never p:0)", async () => {
  const { marketLimitPrice } = await import("./perpl/adapter");
  // BTC mark 85577.5 (pd 1) at 100 bps: a buy may pay up to 86433.28 -> rounded UP to 864333.
  assert.equal(marketLimitPrice(855775n, "close_short", 100), 864333n);
  assert.equal(marketLimitPrice(855775n, "open_long", 100), 864333n);
  // A sell accepts down to 84719.72 -> rounded DOWN to 847217.
  assert.equal(marketLimitPrice(855775n, "close_long", 100), 847217n);
  assert.equal(marketLimitPrice(855775n, "open_short", 100), 847217n);
});
