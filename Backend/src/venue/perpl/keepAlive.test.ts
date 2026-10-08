import assert from "node:assert/strict";
import test from "node:test";

import { PingTimer, SocketTimeline, jitteredDelay } from "./keepAlive";

/// A manual clock for PingTimer: timers run only when the test says so.
function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id: unknown) => void pending.delete(id as number),
    /// Fires the one pending timer (there is never more than one) and returns the delay it was set with.
    fire(): number {
      const [id, timer] = [...pending.entries()][0];
      pending.delete(id);
      timer.fn();
      return timer.ms;
    },
  };
}

test("jitteredDelay stays within +/- jitter of the base", () => {
  assert.equal(jitteredDelay(30_000, 2_000, () => 0), 28_000);
  assert.equal(jitteredDelay(30_000, 2_000, () => 0.5), 30_000);
  assert.equal(jitteredDelay(30_000, 2_000, () => 1), 32_000);
  for (let i = 0; i < 200; i += 1) {
    const d = jitteredDelay(30_000, 2_000);
    assert.ok(d >= 28_000 && d <= 32_000, `delay ${d}`);
  }
});

test("PingTimer: nothing is sent until start(), then one ping per tick with fresh jitter", () => {
  const timers = fakeTimers();
  let sent = 0;
  const rands = [0, 1, 0.5];
  let r = 0;
  const timer = new PingTimer({
    intervalMs: 30_000,
    jitterMs: 2_000,
    send: () => ((sent += 1), true),
    rand: () => rands[r++ % rands.length],
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  assert.equal(timers.pending.size, 0, "armed nothing before start()");
  assert.equal(sent, 0);

  timer.start();
  assert.equal(timer.active, true);
  assert.equal(timers.fire(), 28_000);
  assert.equal(sent, 1);
  assert.equal(timers.fire(), 32_000, "re-armed with a different jitter");
  assert.equal(sent, 2);
  assert.equal(timers.pending.size, 1);
});

test("PingTimer: start() while running never doubles the rate; stop() clears the pending ping", () => {
  const timers = fakeTimers();
  let sent = 0;
  const timer = new PingTimer({ intervalMs: 30_000, jitterMs: 0, send: () => ((sent += 1), true), ...timers });
  timer.start();
  timer.start();
  assert.equal(timers.pending.size, 1);
  timers.fire();
  assert.equal(sent, 1);

  timer.stop();
  assert.equal(timer.active, false);
  assert.equal(timers.pending.size, 0, "no ping left armed after stop()");
  timer.stop(); // idempotent
  timer.start(); // a reconnect starts a fresh cycle
  assert.equal(timers.pending.size, 1);
});

test("PingTimer: a stop() issued inside send() does not re-arm", () => {
  const timers = fakeTimers();
  const timer: PingTimer = new PingTimer({
    intervalMs: 30_000,
    jitterMs: 0,
    send: () => {
      timer.stop();
      return true;
    },
    ...timers,
  });
  timer.start();
  timers.fire();
  assert.equal(timers.pending.size, 0);
});

test("PingTimer: a send that reports 'socket not open' keeps the cadence", () => {
  const timers = fakeTimers();
  const timer = new PingTimer({ intervalMs: 30_000, jitterMs: 0, send: () => false, ...timers });
  timer.start();
  timers.fire();
  assert.equal(timers.pending.size, 1);
});

test("SocketTimeline: reports server ping cadence, what was answered, and the gaps before a close", () => {
  const t = new SocketTimeline(1_000);
  t.signedIn(1_400);
  t.dataFrame(2_000);
  t.serverPing(10_000);
  t.pongSent(10_001);
  t.serverPing(20_000);
  t.pongSent(20_002);
  t.serverPing(31_000);
  t.pongSent(31_001);
  t.appPingSent(31_500);
  t.frameSent(31_500);
  t.appPong(31_600);
  t.dataFrame(32_000);

  const s = t.summary(40_000);
  assert.equal(s.uptimeMs, 39_000);
  assert.equal(s.signedInAfterMs, 400);
  assert.equal(s.serverPings, 3);
  assert.equal(s.pongsSent, 3);
  assert.equal(s.serverPingGapMs, 11_000, "median of the 10 s and 11 s gaps");
  assert.equal(s.msSinceLastServerPing, 9_000);
  assert.equal(s.msSinceLastPongSent, 8_999);
  assert.equal(s.msSinceLastDataFrame, 8_000);
  assert.equal(s.msSinceLastReceived, 8_000, "the newest of data frame and server ping");
  assert.equal(s.msSinceLastAppPingSent, 8_500);
  assert.equal(s.msSinceLastAppPong, 8_400);
  assert.equal(s.appPingsSent, 1);
  assert.equal(s.appPongsReceived, 1);
});

test("SocketTimeline: a silent socket reports nulls, and the 60 s request window slides", () => {
  const t = new SocketTimeline(0);
  const s = t.summary(5_000);
  assert.equal(s.msSinceLastReceived, null);
  assert.equal(s.msSinceLastServerPing, null);
  assert.equal(s.serverPingGapMs, null);
  assert.equal(s.signedInAfterMs, null);

  t.frameSent(1_000);
  t.frameSent(30_000);
  t.pongSent(30_100); // protocol pongs are control frames: not counted against the request budget
  assert.equal(t.summary(50_000).sentLast60s, 2);
  assert.equal(t.summary(70_000).sentLast60s, 1, "the 1 s frame fell out of the window");
});
