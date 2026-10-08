/**
 * Keep-alive pieces of the Perpl trading socket, kept apart from the socket so
 * they can be tested without a network (Spec 06 Part 1).
 *
 * Perpl's docs (websocket.md "Keep-Alive"): a TRADING connection sends an
 * application Ping `{ mt: 1, t }` about every 30 s and the server answers with a
 * Pong (mt: 2); market-data connections need no application ping at all. A
 * `1008 ping timeout` close is "no response to the server's ping", which is a
 * protocol-level ping frame (the message table has no server->client Ping), and
 * `ws` answers those itself unless autoPong is off.
 */

/// base +/- jitter, so two slot sockets do not ping in lockstep.
export function jitteredDelay(baseMs: number, jitterMs: number, rand: () => number = Math.random): number {
  const offset = (rand() * 2 - 1) * jitterMs;
  return Math.max(1_000, Math.round(baseMs + offset));
}

export interface PingTimerOptions {
  intervalMs: number;
  jitterMs: number;
  /// Sends one `{ mt: 1, t }`; returns false when the socket is not open (the tick is skipped).
  send: () => boolean;
  rand?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Application pings on one socket. `start()` is called only once the sign-in has
 * succeeded (first wallet snapshot); `stop()` on close / error / reconnect /
 * forced terminate. Each tick re-arms with fresh jitter, and start() while
 * running is a no-op, so a duplicate start can never double the rate.
 */
export class PingTimer {
  private handle: unknown;
  private running = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: PingTimerOptions) {
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.arm();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== undefined) this.clearTimer(this.handle);
    this.handle = undefined;
  }

  private arm(): void {
    const { intervalMs, jitterMs, rand } = this.options;
    this.handle = this.setTimer(() => {
      this.handle = undefined;
      if (!this.running) return;
      try {
        this.options.send();
      } finally {
        if (this.running) this.arm();
      }
    }, jitteredDelay(intervalMs, jitterMs, rand));
    // A pending ping must not keep a stopping process alive.
    (this.handle as { unref?: () => void } | undefined)?.unref?.();
  }
}

export interface CloseSummary {
  uptimeMs: number;
  /// Since any frame of ours or theirs: data, ping, pong.
  msSinceLastReceived: number | null;
  msSinceLastDataFrame: number | null;
  msSinceLastServerPing: number | null;
  msSinceLastPongSent: number | null;
  msSinceLastAppPingSent: number | null;
  msSinceLastAppPong: number | null;
  serverPings: number;
  pongsSent: number;
  appPingsSent: number;
  appPongsReceived: number;
  /// Median gap between the server's protocol pings on this socket (null with < 2).
  serverPingGapMs: number | null;
  /// Outgoing frames in the last 60 s -- against the trading request budget.
  sentLast60s: number;
  signedInAfterMs: number | null;
}

/**
 * What one socket has seen, so a close can be explained: do the server's pings
 * arrive, how often, did we answer, and what happened right before the close.
 * Every method takes `now` so tests need no clock.
 */
export class SocketTimeline {
  readonly openedAt: number;
  private lastDataFrameAt: number | undefined;
  private lastServerPingAt: number | undefined;
  private lastPongSentAt: number | undefined;
  private lastAppPingAt: number | undefined;
  private lastAppPongAt: number | undefined;
  private signedInAt: number | undefined;
  private pingGaps: number[] = [];
  private sentAt: number[] = [];
  serverPings = 0;
  pongsSent = 0;
  appPingsSent = 0;
  appPongsReceived = 0;

  constructor(now: number) {
    this.openedAt = now;
  }

  dataFrame(now: number): void {
    this.lastDataFrameAt = now;
  }

  signedIn(now: number): void {
    this.signedInAt ??= now;
  }

  serverPing(now: number): void {
    if (this.lastServerPingAt !== undefined) {
      this.pingGaps.push(now - this.lastServerPingAt);
      if (this.pingGaps.length > 200) this.pingGaps.shift();
    }
    this.lastServerPingAt = now;
    this.serverPings += 1;
  }

  pongSent(now: number): void {
    this.lastPongSentAt = now;
    this.pongsSent += 1;
  }

  appPingSent(now: number): void {
    this.lastAppPingAt = now;
    this.appPingsSent += 1;
  }

  appPong(now: number): void {
    this.lastAppPongAt = now;
    this.appPongsReceived += 1;
  }

  /// Every data frame we write, for the requests-per-minute figure.
  frameSent(now: number): void {
    this.recordSent(now);
  }

  private recordSent(now: number): void {
    this.sentAt.push(now);
    if (this.sentAt.length > 500) this.sentAt.shift();
  }

  summary(now: number): CloseSummary {
    const since = (at: number | undefined) => (at === undefined ? null : now - at);
    const lastReceived = Math.max(this.lastDataFrameAt ?? 0, this.lastServerPingAt ?? 0) || undefined;
    const sorted = [...this.pingGaps].sort((a, b) => a - b);
    return {
      uptimeMs: now - this.openedAt,
      msSinceLastReceived: since(lastReceived),
      msSinceLastDataFrame: since(this.lastDataFrameAt),
      msSinceLastServerPing: since(this.lastServerPingAt),
      msSinceLastPongSent: since(this.lastPongSentAt),
      msSinceLastAppPingSent: since(this.lastAppPingAt),
      msSinceLastAppPong: since(this.lastAppPongAt),
      serverPings: this.serverPings,
      pongsSent: this.pongsSent,
      appPingsSent: this.appPingsSent,
      appPongsReceived: this.appPongsReceived,
      serverPingGapMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      sentLast60s: this.sentAt.filter((t) => now - t <= 60_000).length,
      signedInAfterMs: this.signedInAt === undefined ? null : this.signedInAt - this.openedAt,
    };
  }
}
