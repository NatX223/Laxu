/**
 * The real PerplTradingConnection against a local WebSocket server: the first
 * frame is the sign-in, no application ping goes out before the sign-in has
 * succeeded, pings follow once it has, and a close reports what the server's
 * pings looked like from our side.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("trading socket: sign-in first, no ping before it succeeds, pings after, close summary", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as { port: number }).port;
  process.env.PERPL_WS_URL = `ws://127.0.0.1:${port}`;
  process.env.PERPL_WS_PING_MS = "1200"; // jitter is then min(2000, 1200/4) = +/- 300 ms

  const received: Array<{ at: number; frame: Record<string, unknown> }> = [];
  let serverSocket: ServerSocket | undefined;
  wss.on("connection", (socket) => {
    serverSocket = socket;
    socket.on("message", (data) => received.push({ at: Date.now(), frame: JSON.parse(data.toString()) }));
  });

  const { PerplTradingConnection } = await import("./tradingWs");
  const conn = new PerplTradingConnection("socket-test", {
    address: "0x27faec53e9fdae9e4fac0af5cc4731e77ae8e503",
    perplAccountId: "824",
    apiKey: "key",
    apiSecret: "11".repeat(32),
  });
  const closed: Array<Record<string, unknown>> = [];
  conn.on("closed", (event) => closed.push(event));
  try {
    conn.start();
    while (received.length === 0) await wait(10);
    assert.equal(received[0].frame.mt, 29, "the sign-in is the first frame");

    // Signed in? Not yet: the server has not sent the wallet snapshot. No ping may go out.
    await wait(1_700);
    assert.equal(received.filter((r) => r.frame.mt === 1).length, 0, "no ping before sign-in succeeded");

    // The server pings (protocol level) and then accepts the sign-in.
    serverSocket!.ping();
    serverSocket!.send(JSON.stringify({ mt: 19, sn: 100, as: [{ id: 824 }] }));
    const signedInAt = Date.now();
    while (received.filter((r) => r.frame.mt === 1).length === 0 && Date.now() - signedInAt < 3_000) await wait(20);
    const pings = received.filter((r) => r.frame.mt === 1);
    assert.ok(pings.length >= 1, "a ping follows the sign-in");
    assert.ok(pings[0].at - signedInAt >= 800, `first ping ${pings[0].at - signedInAt} ms after sign-in, not at once`);
    assert.equal(typeof pings[0].frame.t, "number");

    // The server closes the way Perpl does on a missed ping.
    serverSocket!.close(1008, "ping timeout");
    while (closed.length === 0) await wait(10);
    const event = closed[0] as Record<string, number | string | null>;
    assert.equal(event.code, 1008);
    assert.equal(event.reason, "ping timeout");
    assert.ok((event.serverPings as number) >= 1, "the server's ping was seen");
    assert.ok((event.pongsSent as number) >= 1, "and answered");
    assert.ok((event.appPingsSent as number) >= 1);
    assert.ok(event.msSinceLastServerPing !== null && event.uptimeMs !== undefined);
  } finally {
    conn.stop();
    wss.close();
  }
});
