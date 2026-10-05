import { EventEmitter } from "node:events";
import WebSocket from "ws";

import { config } from "../../config/env";
import { loadEd25519PrivateKey } from "../../lib/ed25519";
import { createLogger, errorFields } from "../../lib/logger";
import { Mt, OrderStatus, perplChainId, perplTradingWsUrl } from "./config";
import { recordFrame } from "./recorder";
import { getWallet } from "./rest";
import { signInFrame } from "./signing";
import type { ApiAccount, ApiOrder, ApiPosition, ApiStatus, ApiWallet, OrderSpec, PerplCredentials } from "./types";

const log = createLogger("perpl:ws");

/// The socket closed with this request still in flight: its fate is unknown.
/// Callers look it up with findOrderOutcome rather than sending it again blind.
export class ConnectionLostError extends Error {
  constructor(message = "Perpl trading connection lost") {
    super(message);
    this.name = "ConnectionLostError";
  }
}

/// No outcome within PERPL_ORDER_TIMEOUT_MS. The order may still be live.
export class OrderOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderOutcomeUnknownError";
  }
}

/// What the socket learned about one request, still in API units.
export type RawOrderResult =
  /// The gateway refused the frame (mt:3 code != 0). No mt:24 will follow.
  | { kind: "rejected"; code: number; reason: string }
  /// The exchange's verdict, from mt:24 (deduped, see {settleOrderEvents}).
  | { kind: "order"; order: ApiOrder };

/// How an order resolves. IOC market orders end in Filled / Canceled / Expired;
/// an instant order (IncreasePositionCollateral) is done at its first
/// non-failure status.
export type OrderKind = "ioc" | "instant";

const NON_FAILURE = new Set<number>([
  OrderStatus.Open,
  OrderStatus.PartiallyFilled,
  OrderStatus.Filled,
  OrderStatus.Canceled,
  OrderStatus.Expired,
  OrderStatus.Untriggered,
  OrderStatus.Triggered,
  OrderStatus.Executed,
]);
const IOC_TERMINAL = new Set<number>([OrderStatus.Filled, OrderStatus.Canceled, OrderStatus.Expired]);

/**
 * The docs' dedupe for the status messages of one `rq`, in arrival order:
 * once any non-failure status has arrived the request did not fail (later
 * failures are ignored); if only failures arrive, the first one is the answer.
 *
 * For an IOC order the first non-failure may be an intermediate Open /
 * PartiallyFilled, so the fill state is read from the first IOC-terminal
 * event (Filled / Canceled / Expired), taking the largest cumulative `fs` seen.
 * An order that never reports at all is decided on-chain (venueOrders.ts).
 */
// Confirmed on testnet 2026-10-05: every IOC that executed (19/19) sent one mt:24 straight to st:4; 3 of 22 acked IOCs never reported, so "wait for terminal" stays and silence falls to the lot rule (docs/perpl-findings.md#v-tradingws-63)
export function settleOrderEvents(
  events: ApiOrder[],
  kind: OrderKind,
): { done: boolean; order?: ApiOrder } {
  const nonFailures = events.filter((event) => NON_FAILURE.has(event.st));
  if (nonFailures.length > 0) {
    const maxFs = nonFailures.reduce((max, event) => Math.max(max, event.fs ?? 0), 0);
    if (kind === "instant") return { done: true, order: { ...nonFailures[0], fs: maxFs } };
    const terminal = nonFailures.find((event) => IOC_TERMINAL.has(event.st));
    if (terminal) return { done: true, order: { ...terminal, fs: Math.max(maxFs, terminal.fs ?? 0) } };
    return { done: false, order: { ...nonFailures[nonFailures.length - 1], fs: maxFs } };
  }
  const failure = events.find((event) => event.st === OrderStatus.Failed);
  return failure ? { done: true, order: failure } : { done: false };
}

interface Waiter {
  kind: OrderKind;
  resolve: (result: RawOrderResult) => void;
  reject: (error: Error) => void;
}

interface AckWaiter {
  resolve: (status: ApiStatus) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
const PING_INTERVAL_MS = 30_000;
const ACK_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 15_000;
/// A heartbeat head older than this is not trusted for `lb`; REST answers instead.
const HEAD_MAX_AGE_MS = 10_000;
const ORDER_CACHE_LIMIT = 500;

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "stopped";

/**
 * One authenticated trading WebSocket per slot wallet (`/ws/v1/trading`).
 *
 *   - First frame: the signed mt:29 ApiKeySignIn (the testnet closes an
 *     unauthenticated socket after 10s).
 *   - Snapshots mt:19 (wallet: account id, `lfr`, `fw`, balance; seeds the
 *     heartbeat sequence), mt:23 (open orders), mt:26 (positions); updates
 *     mt:21 (account -- `fw` and `lfr` re-read every time), mt:24 (orders),
 *     mt:25 (fills), mt:27 (positions), mt:100 (heartbeat: head block).
 *   - A heartbeat whose `sn` is not previous + 1 means frames were lost:
 *     force a reconnect for fresh snapshots (only a warning when
 *     PERPL_HEARTBEAT_GAP_RECONNECT=false).
 *   - Any close rejects every in-flight order with ConnectionLostError.
 *   - Frames are queued and handled on the next turn of the event loop, never
 *     inside the socket's receive callback, and `ws` answers server pings
 *     itself (autoPong): a busy handler can never delay a pong.
 *
 * Emits `position` (ApiPosition, plus each settlement event in `e[]`) and
 * `account` (ApiAccount).
 */
export class PerplTradingConnection extends EventEmitter {
  private ws: WebSocket | undefined;
  private state: ConnectionState = "idle";
  private retryCount = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;

  private lastSn: number | undefined;
  private headBlock: bigint | undefined;
  private headAt = 0;
  private account: ApiAccount | undefined;
  private snapshotReady = false;
  private readyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  private frameSn = 0;
  /// Received frames waiting to be handled (see {enqueue}).
  private inbox: Array<{ ws: WebSocket; text: string }> = [];
  private draining = false;
  /// Server pings seen on the current socket -- for the soak's diagnostics.
  serverPings = 0;
  private acks = new Map<number, AckWaiter>();
  /// Every mt:24 event seen for our account, per `rq`, in arrival order.
  private orderEvents = new Map<string, ApiOrder[]>();
  private orderWaiters = new Map<string, Set<Waiter>>();

  /// Bumped on every new socket -- lets a caller tell whether it reconnected
  /// since it sent an order.
  epoch = 0;
  lastError: string | undefined;

  constructor(
    readonly slotId: string,
    private credentials: PerplCredentials,
  ) {
    super();
    this.setMaxListeners(50);
  }

  /// Pick up a changed account id (after provisioning) without a new object.
  updateCredentials(credentials: PerplCredentials): void {
    this.credentials = credentials;
  }

  start(): void {
    if (this.state === "connecting" || this.state === "open" || this.state === "reconnecting") return;
    this.connect();
  }

  stop(): void {
    this.state = "stopped";
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.failInFlight(new ConnectionLostError("Perpl trading connection stopped"));
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(new ConnectionLostError("connection stopped"));
    this.ws?.removeAllListeners();
    this.ws?.terminate();
    this.ws = undefined;
  }

  status(): { state: ConnectionState; head: string | null; headAgeMs: number | null; forwarding: boolean | null; lastError?: string } {
    return {
      state: this.state,
      head: this.headBlock?.toString() ?? null,
      headAgeMs: this.headBlock === undefined ? null : Date.now() - this.headAt,
      forwarding: this.account?.fw ?? null,
      lastError: this.lastError,
    };
  }

  /// The account as of the latest mt:19 / mt:21.
  accountState(): ApiAccount | undefined {
    return this.account;
  }

  /// The latest heartbeat head, if any.
  head(): bigint | undefined {
    return this.headBlock;
  }

  /// A head block to build `lb` from: the heartbeat's when recent, else the
  /// `sn` of a REST wallet snapshot (the block it is current as of).
  async currentHead(): Promise<bigint> {
    if (this.headBlock !== undefined && Date.now() - this.headAt < HEAD_MAX_AGE_MS) return this.headBlock;
    const wallet = await getWallet(this.credentials);
    if (wallet.sn === undefined) throw new Error("Perpl wallet snapshot carried no sn (head block)");
    const head = BigInt(wallet.sn);
    if (this.headBlock === undefined || head > this.headBlock) {
      this.headBlock = head;
      this.headAt = Date.now();
    }
    return head;
  }

  /// Resolves once this socket has signed in and received the wallet snapshot.
  ready(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    this.start();
    if (this.state === "open" && this.snapshotReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((waiter) => waiter.resolve !== done);
        reject(new ConnectionLostError(`Perpl trading socket for slot ${this.slotId} not ready after ${timeoutMs}ms`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.readyWaiters.push({
        resolve: done,
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /// What the socket has already seen for `rq` (this connection's lifetime).
  seenOrder(requestId: bigint | string, kind: OrderKind = "ioc"): { done: boolean; order?: ApiOrder } | undefined {
    const events = this.orderEvents.get(String(requestId));
    return events ? settleOrderEvents(events, kind) : undefined;
  }

  /**
   * Send one mt:22 OrderRequest and wait for its outcome:
   *   1. a unique non-zero frame `sn`, echoed as `cid` on exactly one mt:3;
   *   2. mt:3 `code != 0` -> rejected (no mt:24 follows);
   *   3. otherwise the deduped mt:24 events for `spec.rq`.
   *
   * Throws ConnectionLostError if the socket closes first, and
   * OrderOutcomeUnknownError past PERPL_ORDER_TIMEOUT_MS -- in both cases the
   * order may be live, so the caller must look it up, never resend blind.
   */
  async sendOrder(spec: OrderSpec, kind: OrderKind = "ioc"): Promise<RawOrderResult> {
    await this.ready();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new ConnectionLostError();

    const rq = String(spec.rq);
    const outcome = this.watchOrder(rq, kind);
    const sn = this.nextFrameSn();
    const ack = this.awaitAck(sn);

    try {
      this.send(ws, { mt: Mt.OrderRequest, sn, ...spec });
    } catch (error) {
      outcome.cancel();
      this.acks.get(sn)?.reject(new ConnectionLostError());
      throw new ConnectionLostError(`send failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    let status: ApiStatus;
    try {
      status = await ack;
    } catch (error) {
      outcome.cancel();
      throw error;
    }
    if (status.code !== 0) {
      outcome.cancel();
      return { kind: "rejected", code: status.code, reason: status.error ?? `code ${status.code}` };
    }
    return outcome.promise;
  }

  // --- internals --------------------------------------------------------------------

  private enqueue(ws: WebSocket, text: string): void {
    this.inbox.push({ ws, text });
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => this.drain());
  }

  /// Handles queued frames in arrival order, yielding to the event loop
  /// between batches so a burst of frames never starves the socket.
  private drain(): void {
    const BATCH = 50;
    for (let i = 0; i < BATCH && this.inbox.length > 0; i += 1) {
      const { ws, text } = this.inbox.shift()!;
      // A frame from a socket already replaced belongs to a dead connection.
      if (ws !== this.ws) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(text) as Record<string, unknown>;
      } catch {
        recordFrame(this.slotId, "in", { raw: text });
        log.warn("unparseable trading frame", { slotId: this.slotId });
        continue;
      }
      recordFrame(this.slotId, "in", message);
      try {
        this.handle(message);
      } catch (error) {
        log.error("trading frame handler threw", { slotId: this.slotId, mt: message.mt, ...errorFields(error) });
      }
    }
    if (this.inbox.length > 0) setImmediate(() => this.drain());
    else this.draining = false;
  }

  /// Every outgoing frame goes through here (and the recorder, when on).
  private send(ws: WebSocket, frame: Record<string, unknown>): void {
    recordFrame(this.slotId, "out", frame);
    ws.send(JSON.stringify(frame));
  }

  private nextFrameSn(): number {
    this.frameSn = this.frameSn >= 2 ** 31 ? 1 : this.frameSn + 1;
    return this.frameSn;
  }

  private awaitAck(sn: number): Promise<ApiStatus> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.acks.delete(sn);
        // The frame may have been forwarded; only a lookup can tell.
        reject(new OrderOutcomeUnknownError(`no mt:3 status for frame ${sn} within ${ACK_TIMEOUT_MS}ms`));
      }, ACK_TIMEOUT_MS);
      this.acks.set(sn, {
        resolve: (status) => {
          clearTimeout(timer);
          this.acks.delete(sn);
          resolve(status);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.acks.delete(sn);
          reject(error);
        },
        timer,
      });
    });
  }

  private watchOrder(rq: string, kind: OrderKind): { promise: Promise<RawOrderResult>; cancel: () => void } {
    let waiter!: Waiter;
    let timer: NodeJS.Timeout | undefined;
    const remove = () => {
      if (timer) clearTimeout(timer);
      const set = this.orderWaiters.get(rq);
      set?.delete(waiter);
      if (set && set.size === 0) this.orderWaiters.delete(rq);
    };
    const promise = new Promise<RawOrderResult>((resolve, reject) => {
      waiter = {
        kind,
        resolve: (result) => {
          remove();
          resolve(result);
        },
        reject: (error) => {
          remove();
          reject(error);
        },
      };
      timer = setTimeout(() => {
        const seen = this.seenOrder(rq, kind);
        // An IOC that reported a partial fill but no terminal status yet: the
        // fill is real, report it.
        if (seen?.order && (seen.order.fs ?? 0) > 0) {
          waiter.resolve({ kind: "order", order: seen.order });
          return;
        }
        waiter.reject(
          new OrderOutcomeUnknownError(`no outcome for rq ${rq} within ${config.perplOrderTimeoutMs}ms`),
        );
      }, config.perplOrderTimeoutMs);
    });
    const set = this.orderWaiters.get(rq) ?? new Set<Waiter>();
    set.add(waiter);
    this.orderWaiters.set(rq, set);

    // Already seen (e.g. a resend of the same rq): settle straight away.
    const seen = this.seenOrder(rq, kind);
    if (seen?.done && seen.order) waiter.resolve({ kind: "order", order: seen.order });

    return { promise, cancel: () => remove() };
  }

  private connect(): void {
    if (this.state === "stopped") return;
    this.state = this.retryCount === 0 && this.epoch === 0 ? "connecting" : "reconnecting";
    this.snapshotReady = false;
    this.lastSn = undefined;
    this.epoch += 1;

    // autoPong is ws's default; explicit because a late pong is what a
    // `1008 ping timeout` close would mean (docs/perpl-findings.md#f-1008).
    const ws = new WebSocket(perplTradingWsUrl(), { autoPong: true });
    this.ws = ws;
    this.serverPings = 0;

    ws.on("ping", () => {
      this.serverPings += 1;
    });

    ws.on("open", () => {
      try {
        // Must be the first frame, within the idle timeout.
        this.send(
          ws,
          signInFrame({
            key: loadEd25519PrivateKey(this.credentials.apiSecret),
            apiKey: this.credentials.apiKey,
            chainId: perplChainId(),
          }),
        );
      } catch (error) {
        this.lastError = `sign-in failed: ${error instanceof Error ? error.message : String(error)}`;
        log.error("trading socket sign-in failed", { slotId: this.slotId, ...errorFields(error) });
        ws.close();
        return;
      }
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) this.send(ws, { mt: Mt.Ping, t: Date.now() });
      }, PING_INTERVAL_MS);
    });

    // Only queue here: the receive callback returns at once.
    ws.on("message", (data) => this.enqueue(ws, data.toString()));

    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.lastError = `closed ${code}${reason.length ? ` ${reason.toString()}` : ""}`;
      // 3401 = auth failure: the reconnect re-signs with a fresh timestamp + nonce.
      log.warn("trading socket closed", {
        slotId: this.slotId,
        code,
        reason: reason.toString(),
        serverPings: this.serverPings,
        queued: this.inbox.length,
      });
      this.failInFlight(new ConnectionLostError(`Perpl trading socket closed (${code})`));
      this.scheduleReconnect();
    });

    ws.on("error", (error) => {
      this.lastError = error.message;
      log.warn("trading socket error", { slotId: this.slotId, error: error.message });
    });
  }

  private scheduleReconnect(): void {
    if (this.state === "stopped") return;
    this.state = "reconnecting";
    const delay = RECONNECT_DELAYS_MS[Math.min(this.retryCount, RECONNECT_DELAYS_MS.length - 1)];
    this.retryCount += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /// Every waiter still open on this socket learns it is gone.
  private failInFlight(error: Error): void {
    for (const ack of [...this.acks.values()]) ack.reject(error);
    for (const set of [...this.orderWaiters.values()]) for (const waiter of [...set]) waiter.reject(error);
  }

  private forceReconnect(why: string): void {
    log.warn("forcing trading socket reconnect", { slotId: this.slotId, why });
    this.ws?.terminate();
  }

  private isOurAccount(id: unknown): boolean {
    if (this.credentials.perplAccountId === null) return true;
    return String(id) === this.credentials.perplAccountId;
  }

  private handle(message: Record<string, unknown>): void {
    const mt = Number(message.mt);
    switch (mt) {
      case Mt.WalletSnapshot: {
        const wallet = message as unknown as ApiWallet;
        this.lastSn = typeof wallet.sn === "number" ? wallet.sn : undefined;
        const accounts = wallet.as ?? [];
        this.account =
          accounts.find((account) => this.isOurAccount(account.id) && this.credentials.perplAccountId !== null) ??
          accounts[0];
        if (this.account) this.emit("account", this.account);
        this.state = "open";
        this.snapshotReady = true;
        this.retryCount = 0;
        this.lastError = undefined;
        for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
        return;
      }
      case Mt.AccountUpdate: {
        const account = message as unknown as ApiAccount;
        if (!this.isOurAccount(account.id)) return;
        this.account = { ...(this.account ?? account), ...account };
        this.emit("account", this.account);
        return;
      }
      case Mt.Heartbeat: {
        const sn = Number(message.sn);
        // Confirmed on testnet 2026-10-05: the first mt:100 sn is the mt:19 sn + 1, then +1 per beat (sn == block); no gap in 609 beats (docs/perpl-findings.md#v-tradingws-471)
        if (this.lastSn !== undefined && sn !== this.lastSn + 1) {
          const why = `heartbeat sequence gap (${this.lastSn} -> ${sn})`;
          if (config.perplHeartbeatGapReconnect) {
            this.forceReconnect(why);
            return;
          }
          // PERPL_HEARTBEAT_GAP_RECONNECT=false: note it and carry on.
          log.warn("heartbeat sequence gap ignored", { slotId: this.slotId, why });
        }
        this.lastSn = sn;
        if (message.h !== undefined) {
          this.headBlock = BigInt(message.h as number);
          this.headAt = Date.now();
        }
        return;
      }
      case Mt.StatusResponse: {
        const cid = message.cid === undefined ? undefined : Number(message.cid);
        if (cid === undefined) return;
        this.acks.get(cid)?.resolve((message.status as ApiStatus | undefined) ?? { code: 0 });
        return;
      }
      case Mt.OrdersSnapshot:
      case Mt.OrdersUpdate: {
        for (const order of (message.d as ApiOrder[] | undefined) ?? []) this.recordOrder(order);
        return;
      }
      case Mt.PositionsSnapshot:
      case Mt.PositionsUpdate: {
        for (const position of (message.d as ApiPosition[] | undefined) ?? []) {
          if (!this.isOurAccount(position.acc)) continue;
          this.emit("position", position, { snapshot: mt === Mt.PositionsSnapshot });
          for (const event of position.e ?? []) {
            this.emit("position", { ...event, mkt: event.mkt ?? position.mkt, acc: event.acc ?? position.acc }, {
              snapshot: false,
              settlementEvent: true,
            });
          }
        }
        return;
      }
      case Mt.FillsUpdate:
        this.emit("fills", message.d);
        return;
      default:
        return;
    }
  }

  private recordOrder(order: ApiOrder): void {
    if (!this.isOurAccount(order.acc) || order.rq === undefined) return;
    const rq = String(order.rq);
    const events = this.orderEvents.get(rq) ?? [];
    events.push(order);
    this.orderEvents.set(rq, events);
    if (this.orderEvents.size > ORDER_CACHE_LIMIT) {
      const oldest = this.orderEvents.keys().next().value;
      if (oldest !== undefined && !this.orderWaiters.has(oldest)) this.orderEvents.delete(oldest);
    }
    const waiters = this.orderWaiters.get(rq);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      const settled = settleOrderEvents(events, waiter.kind);
      if (settled.done && settled.order) waiter.resolve({ kind: "order", order: settled.order });
    }
  }
}
