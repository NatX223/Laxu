import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import WebSocket from "ws";

import { OrderStatus } from "./config";
import { PerplTradingConnection, settleOrderEvents, type RawOrderResult } from "./tradingWs";
import type { ApiOrder, OrderSpec } from "./types";
import { lotsToSize6, pnsToPrice18 } from "./units";

/// Recorded on Monad testnet 2026-10-05 (redacted): Backend/fixtures/perpl/*.jsonl.
function frames(name: string): Array<{ dir: "in" | "out"; frame: Record<string, unknown> }> {
  return readFileSync(join(process.cwd(), "fixtures", "perpl", name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/// A signed-in connection on a fake socket: what we send is captured, what the
/// server sent is replayed through the real frame handler.
function harness(accountId = "824") {
  const conn = new PerplTradingConnection("test-slot", {
    address: "0x27faec53e9fdae9e4fac0af5cc4731e77ae8e503",
    perplAccountId: accountId,
    apiKey: "unused",
    apiSecret: "00".repeat(32),
  });
  const sent: Array<Record<string, unknown>> = [];
  const fakeWs = {
    readyState: WebSocket.OPEN,
    send: (text: string) => sent.push(JSON.parse(text)),
    removeAllListeners: () => undefined,
    terminate: () => undefined,
  };
  Object.assign(conn as unknown as Record<string, unknown>, { ws: fakeWs, state: "open", snapshotReady: true });
  const feed = (frame: Record<string, unknown>) =>
    (conn as unknown as { handle: (f: Record<string, unknown>) => void }).handle(frame);
  return { conn, sent, feed };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function specOf(recorded: Record<string, unknown>): OrderSpec {
  const { mt: _mt, sn: _sn, ...spec } = recorded;
  return spec as unknown as OrderSpec;
}

/// Sends the recorded order, then replays every recorded inbound frame.
async function replay(name: string) {
  const recorded = frames(name);
  const order = recorded.find((r) => r.dir === "out" && r.frame.mt === 22)!.frame;
  const { conn, sent, feed } = harness();
  const result = conn.sendOrder(specOf(order), "ioc");
  await tick();
  assert.equal(sent.length, 1, "the order went out");
  assert.equal(sent[0].rq, order.rq);
  for (const r of recorded) if (r.dir === "in") feed(r.frame);
  return { conn, feed, result: await result, order };
}

test('tradingWs: recorded IOC fill frames resolve to "filled" with the right size and price', async () => {
  const { result, order } = await replay("frames.ioc-fill.jsonl");
  assert.equal(result.kind, "order");
  const filled = (result as Extract<RawOrderResult, { kind: "order" }>).order;
  assert.equal(filled.rq, order.rq);
  assert.equal(filled.st, OrderStatus.Filled);
  assert.equal(filled.fs, 14);
  assert.equal(filled.fp, 268707);
  // In Laxu units (ETH: 3 size decimals, 2 price decimals): 0.014 ETH at $2687.07.
  assert.equal(lotsToSize6(BigInt(filled.fs!), 3), 14_000n);
  assert.equal(pnsToPrice18(filled.fp!, 2), 268707n * 10n ** 16n);
});

test('tradingWs: a gateway rejection (mt:3 code≠0) resolves "failed" without waiting for mt:24', async () => {
  // Shape per websocket.md "Command Status": no mt:24 ever follows a non-zero code.
  const { conn, sent, feed } = harness();
  const started = Date.now();
  const pending = conn.sendOrder({ rq: 50, mkt: 32, acc: 824, t: 1, p: 0, s: 1, fl: 4, lv: 200, lb: 0 }, "ioc");
  await tick();
  feed({ mt: 3, sid: 100, sn: 9, cid: sent[0].sn, status: { code: 400, error: "last exec block already expired" } });
  const result = await pending;
  assert.deepEqual(result, { kind: "rejected", code: 400, reason: "last exec block already expired" });
  assert.ok(Date.now() - started < 1_000, "resolved straight away, not at the order timeout");
});

test("tradingWs: duplicate and late failure frames for an rq are ignored after a final status", async () => {
  const { conn, feed, result, order } = await replay("frames.ioc-fill.jsonl");
  assert.equal(result.kind, "order");
  const fill = frames("frames.ioc-fill.jsonl").find((r) => r.frame.mt === 24)!.frame;
  const late = (st: number, extra: Partial<ApiOrder> = {}) => ({
    ...fill,
    d: (fill.d as ApiOrder[]).map((o) => ({ ...o, st, ...extra })),
  });
  // The same Filled again, then a late Failed (sr:32 OrderDescIdTooLow, as the
  // forwarder's duplicate t:6 sent on 2026-10-05).
  feed(late(OrderStatus.Filled));
  feed(late(OrderStatus.Failed, { sr: 32, fs: 0 }));
  const seen = conn.seenOrder(BigInt(order.rq as number), "ioc");
  assert.equal(seen?.done, true);
  assert.equal(seen?.order?.st, OrderStatus.Filled, "first non-failure stays the answer");
  assert.equal(seen?.order?.fs, 14);

  // The same rule on its own: only failures -> the first failure.
  const f1 = { rq: 1, st: OrderStatus.Failed, sr: 1 } as ApiOrder;
  const f2 = { rq: 1, st: OrderStatus.Failed, sr: 32 } as ApiOrder;
  assert.equal(settleOrderEvents([f1, f2], "ioc").order?.sr, 1);
});
