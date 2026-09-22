import { EventEmitter } from "node:events";
import WebSocket from "ws";

import { config } from "../config/env";
import { addDecimal, compareDecimal, isZeroDecimal, parseDecimal, formatDecimal } from "../lib/decimal";
import { createLogger, errorFields } from "../lib/logger";
import { TimeoutError } from "../lib/async";
import { TERMINAL_ORDER_STATUSES, type ArcusFill, type ArcusOrderUpdate } from "./types";

const log = createLogger("arcus:ws");

/**
 * Persistent Arcus WebSocket.
 *
 * `POST /v1/placeOrder` answers 202 ACK -- it is an acknowledgement, not a
 * settlement, and carries no fill price. The actual execution arrives on the
 * `userFills` channel, with the order's terminal state on `orders`. So this
 * listener has to be connected and subscribed *before* the REST call goes out,
 * not attached afterwards once the response turns out to be insufficient.
 *
 * Subscribing is unauthenticated on Arcus: account channels take an address and
 * an accountIndex, and no signature. `accountIndex` is part of subscription
 * identity -- omitting it silently subscribes to index 0 instead.
 */

interface SubscriptionKey {
  address: string;
  accountIndex: number;
}

function keyOf(sub: SubscriptionKey): string {
  return `${sub.address.toLowerCase()}:${sub.accountIndex}`;
}

export interface OrderOutcome {
  orderId: string;
  clientId?: string;
  status: string;
  /// Aggregate filled size, human-readable base units.
  filledSize: string;
  /// Size-weighted average fill price, human-readable USD.
  averagePrice: string;
  fills: ArcusFill[];
  /// True when the order ended without filling anything.
  unfilled: boolean;
  cancelReason?: string;
  rejectReason?: string;
}

interface PendingOrder {
  clientId?: string;
  orderId?: string;
  accountIndex: number;
  address: string;
  fills: Map<string, ArcusFill>;
  terminalStatus?: string;
  cancelReason?: string;
  rejectReason?: string;
  resolve: (outcome: OrderOutcome) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

function vwap(fills: ArcusFill[]): { size: string; price: string } {
  let size = "0";
  let notional = "0";
  for (const fill of fills) {
    size = addDecimal(size, fill.size);
    const fillSize = parseDecimal(fill.size);
    const fillPrice = parseDecimal(fill.price);
    notional = addDecimal(notional, formatDecimal({
      units: fillSize.units * fillPrice.units,
      scale: fillSize.scale + fillPrice.scale,
    }));
  }
  if (isZeroDecimal(size)) return { size: "0", price: "0" };

  // notional / size, carried to 18 places -- more than any market's tick needs.
  const n = parseDecimal(notional);
  const s = parseDecimal(size);
  const scale = 18;
  const numerator = n.units * 10n ** BigInt(scale + s.scale);
  const denominator = s.units * 10n ** BigInt(n.scale);
  return { size, price: formatDecimal({ units: numerator / denominator, scale }) };
}

function asArray<T>(contents: unknown, ...keys: string[]): T[] {
  if (Array.isArray(contents)) return contents as T[];
  if (contents && typeof contents === "object") {
    for (const key of keys) {
      const value = (contents as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as T[];
    }
    // Some frames deliver a single object rather than a one-element array.
    if (keys.some((key) => key in (contents as Record<string, unknown>))) return [];
    return [contents as T];
  }
  return [];
}

class ArcusStream extends EventEmitter {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private closed = false;
  private reconnectAttempts = 0;
  private heartbeat?: NodeJS.Timeout;

  /// Subscriptions we intend to hold. Replayed verbatim after a reconnect, so a
  /// dropped socket does not silently stop delivering fills for a live order.
  private readonly desired = new Map<string, SubscriptionKey>();
  private readonly acked = new Set<string>();
  private readonly ackWaiters = new Map<string, Array<() => void>>();

  private readonly pending = new Map<string, PendingOrder>();

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(config.arcusWsUrl);
      this.socket = socket;

      socket.on("open", () => {
        log.info("connected", { url: config.arcusWsUrl });
        this.reconnectAttempts = 0;
        this.connecting = undefined;
        this.startHeartbeat();
        for (const sub of this.desired.values()) this.sendSubscribe(sub);
        resolve();
      });

      socket.on("message", (raw) => this.onMessage(raw));

      socket.on("error", (error) => {
        log.warn("socket error", errorFields(error));
        if (this.connecting) {
          this.connecting = undefined;
          reject(error);
        }
      });

      socket.on("close", (code) => {
        log.warn("socket closed", { code });
        this.stopHeartbeat();
        this.acked.clear();
        this.socket = undefined;
        this.connecting = undefined;
        if (!this.closed) this.scheduleReconnect();
      });
    });

    return this.connecting;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.ping();
    }, 20_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempts, 6));
    setTimeout(() => {
      if (this.closed) return;
      this.connect().catch((error) => log.warn("reconnect failed", errorFields(error)));
    }, delay);
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private sendSubscribe(sub: SubscriptionKey): void {
    for (const channel of ["userFills", "orders"]) {
      this.send({
        type: "subscribe",
        channel,
        id: sub.address.toLowerCase(),
        accountIndex: sub.accountIndex,
        // The snapshot replays historical fills. We only act on live frames, but
        // it is kept because its arrival is the signal the subscription is real.
        snapshot: true,
      });
    }
  }

  /// Resolves once Arcus has acknowledged both channel subscriptions for this
  /// subaccount. Callers must await this before placing an order.
  async ensureSubscribed(address: string, accountIndex: number): Promise<void> {
    const sub = { address: address.toLowerCase(), accountIndex };
    const key = keyOf(sub);
    this.desired.set(key, sub);

    await this.connect();
    if (this.acked.has(key)) return;

    this.sendSubscribe(sub);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.ackWaiters.get(key) ?? [];
        this.ackWaiters.set(
          key,
          waiters.filter((w) => w !== onAck),
        );
        reject(new TimeoutError(`Arcus subscription for ${key} was not acknowledged`));
      }, config.arcusRequestTimeoutMs);

      const onAck = () => {
        clearTimeout(timer);
        resolve();
      };

      const waiters = this.ackWaiters.get(key) ?? [];
      waiters.push(onAck);
      this.ackWaiters.set(key, waiters);
    });
  }

  private markAcked(key: string): void {
    if (this.acked.has(key)) return;
    this.acked.add(key);
    const waiters = this.ackWaiters.get(key);
    if (!waiters) return;
    this.ackWaiters.delete(key);
    for (const waiter of waiters) waiter();
  }

  private onMessage(raw: WebSocket.RawData): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch (error) {
      log.warn("unparseable frame", errorFields(error));
      return;
    }

    const type = frame.type as string | undefined;
    const channel = frame.channel as string | undefined;
    const id = typeof frame.id === "string" ? frame.id.toLowerCase() : undefined;
    const accountIndex = (frame.accountIndex as number | undefined) ?? 0;

    if (type === "subscribed" && id && channel) {
      // `subscribed` carries the initial snapshot; it is the only acknowledgement
      // Arcus sends, so a health check must count frames with contents rather
      // than waiting for a bare ack that never arrives.
      this.markAcked(`${id}:${accountIndex}`);
      return;
    }

    if (type === "error") {
      log.warn("server error frame", { frame });
      return;
    }

    if (type !== "channel_data") return;

    if (channel === "userFills") {
      for (const fill of asArray<ArcusFill>(frame.contents, "fills")) {
        this.onFill(fill);
      }
      return;
    }

    if (channel === "orders") {
      for (const order of asArray<ArcusOrderUpdate>(frame.contents, "orders")) {
        this.onOrderUpdate(order);
      }
    }
  }

  private find(clientId?: string, orderId?: string): PendingOrder | undefined {
    if (clientId) {
      const byClient = this.pending.get(clientId);
      if (byClient) return byClient;
    }
    if (!orderId) return undefined;
    for (const entry of this.pending.values()) {
      if (entry.orderId === orderId) return entry;
    }
    return undefined;
  }

  private onFill(fill: ArcusFill): void {
    if (!fill?.tradeId) return;
    const entry = this.find(fill.clientId, fill.orderId);
    if (!entry) return;

    // Dedupe by tradeId: the snapshot and the live stream can overlap, and a
    // reconnect replays the snapshot again.
    if (entry.fills.has(fill.tradeId)) return;
    entry.fills.set(fill.tradeId, fill);
    if (!entry.orderId) entry.orderId = fill.orderId;

    log.debug("fill", {
      tradeId: fill.tradeId,
      orderId: fill.orderId,
      size: fill.size,
      price: fill.price,
      remaining: fill.remainingSize,
    });

    // An order fully filled in one or more parts is terminal even if the
    // `orders` frame is still in flight.
    if (fill.remainingSize !== undefined && isZeroDecimal(fill.remainingSize)) {
      entry.terminalStatus = entry.terminalStatus ?? "FILLED";
      this.settle(entry);
    }
  }

  private onOrderUpdate(order: ArcusOrderUpdate): void {
    if (!order?.orderId) return;
    const entry = this.find(order.clientId, order.orderId);
    if (!entry) return;
    if (!entry.orderId) entry.orderId = order.orderId;

    if (TERMINAL_ORDER_STATUSES.has(order.status?.toUpperCase?.() ?? "")) {
      entry.terminalStatus = order.status.toUpperCase();
      entry.cancelReason = order.cancelReason;
      entry.rejectReason = order.rejectReason;
      this.settle(entry);
    }
  }

  private settle(entry: PendingOrder): void {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    if (entry.clientId) this.pending.delete(entry.clientId);

    const fills = [...entry.fills.values()].sort((a, b) => a.createdAt - b.createdAt);
    const { size, price } = vwap(fills);

    entry.resolve({
      orderId: entry.orderId ?? "",
      clientId: entry.clientId,
      status: entry.terminalStatus ?? "UNKNOWN",
      filledSize: size,
      averagePrice: price,
      fills,
      unfilled: compareDecimal(size, "0") === 0,
      cancelReason: entry.cancelReason,
      rejectReason: entry.rejectReason,
    });
  }

  /**
   * Register interest in an order's outcome BEFORE placing it.
   *
   * Returns a handle whose `.outcome` resolves when the order reaches a terminal
   * state. `bindOrderId` is called with the id the REST ACK echoes back, which
   * lets fills that carry no clientId still be matched.
   */
  expectOrder(params: {
    address: string;
    accountIndex: number;
    clientId: string;
    timeoutMs?: number;
  }): { outcome: Promise<OrderOutcome>; bindOrderId: (orderId: string) => void; cancel: () => void } {
    const timeoutMs = params.timeoutMs ?? config.fillTimeoutMs;

    let resolve!: (outcome: OrderOutcome) => void;
    let reject!: (error: Error) => void;
    const outcome = new Promise<OrderOutcome>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const entry: PendingOrder = {
      clientId: params.clientId,
      accountIndex: params.accountIndex,
      address: params.address.toLowerCase(),
      fills: new Map(),
      resolve,
      reject,
      settled: false,
      timer: setTimeout(() => {
        if (entry.settled) return;
        // Partial fills before a timeout are still real -- hand them back rather
        // than discarding them, so the caller can settle on what actually traded.
        if (entry.fills.size > 0) {
          entry.terminalStatus = "TIMEOUT_PARTIAL";
          this.settle(entry);
          return;
        }
        entry.settled = true;
        this.pending.delete(params.clientId);
        reject(new TimeoutError(`No fill for order ${params.clientId} within ${timeoutMs}ms`));
      }, timeoutMs),
    };

    this.pending.set(params.clientId, entry);

    return {
      outcome,
      bindOrderId: (orderId: string) => {
        entry.orderId = orderId;
      },
      cancel: () => {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timer);
        this.pending.delete(params.clientId);
      },
    };
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = undefined;
  }
}

let instance: ArcusStream | undefined;

export function getArcusStream(): ArcusStream {
  if (!instance) instance = new ArcusStream();
  return instance;
}

export function closeArcusStream(): void {
  instance?.close();
  instance = undefined;
}

export type { ArcusStream };
