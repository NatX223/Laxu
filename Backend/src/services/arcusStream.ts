import WebSocket from "ws";

import { getAccountTransferUpdates, getOrderStatus } from "../arcus/client";
import {
  TERMINAL_ORDER_STATUSES,
  type AccountTransferUpdate,
  type ArcusFill,
  type ArcusPosition,
} from "../arcus/types";
import { db } from "../config/db";
import { config } from "../config/env";
import { TimeoutError, sleep } from "../lib/async";
import { addDecimal, compareDecimal, formatDecimal, isZeroDecimal, parseDecimal } from "../lib/decimal";
import { createLogger, errorFields } from "../lib/logger";

const log = createLogger("arcus-stream");

/**
 * One shared Arcus stream for every slot.
 *
 * Subscribing is never authenticated on Arcus -- account channels are keyed by
 * (wallet address, accountIndex) alone -- and one connection can carry many
 * subaccounts. So every slot needs its own API key (a key signs for exactly
 * one index) but not its own connection: every slot, whatever its status, is
 * subscribed to three channels on a small pool of connections.
 *
 *   userFills               resolves pending orders; `liquidation` marker -> liquidation handler
 *   positions               FLAT row confirms a close (or flags an unexpected one)
 *   accountTransferUpdates  DEPOSIT / WITHDRAWAL resolve funding waiters
 *
 * Limits per IP: 50 connections, 100 subscriptions per connection, 24h max
 * connection life. Each connection is capped at ARCUS_STREAM_SUBS_PER_CONNECTION
 * (90) and a new one opens when it fills; each is replaced at 23h, new socket
 * first. The stream is the main signal, never the only one: every waiter also
 * polls REST every ARCUS_FALLBACK_POLL_MS, and whichever answers first wins.
 */

export const ACCOUNT_CHANNELS = ["userFills", "positions", "accountTransferUpdates"] as const;
type AccountChannel = (typeof ACCOUNT_CHANNELS)[number];

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const STALE_AFTER_MS = 60_000;
const PING_EVERY_MS = 20_000;
const ROTATE_AFTER_MS = 23 * 60 * 60_000;
/// First REST check for an order: an IOC that matched nothing never produces a
/// fill, so REST is what settles it -- sooner than the regular fallback cadence.
const FIRST_ORDER_POLL_MS = 3_000;

interface AccountKey {
  address: string;
  accountIndex: number;
}

const keyOf = (sub: AccountKey) => `${sub.address.toLowerCase()}:${sub.accountIndex}`;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/// Live frames may say fillSize/fillPrice where REST says size/price.
export function normaliseFill(raw: ArcusFill): ArcusFill {
  return {
    ...raw,
    size: raw.size ?? raw.fillSize ?? "0",
    price: raw.price ?? raw.fillPrice ?? "0",
  };
}

export function normaliseTransfer(raw: AccountTransferUpdate): AccountTransferUpdate {
  return { ...raw, id: raw.id ?? raw.eventId ?? raw.withdrawalId ?? "" };
}

export function vwap(fills: Array<Pick<ArcusFill, "size" | "price">>): { size: string; price: string } {
  let size = "0";
  let notional = "0";
  for (const fill of fills) {
    size = addDecimal(size, fill.size);
    const s = parseDecimal(fill.size);
    const p = parseDecimal(fill.price);
    notional = addDecimal(notional, formatDecimal({ units: s.units * p.units, scale: s.scale + p.scale }));
  }
  if (isZeroDecimal(size)) return { size: "0", price: "0" };
  // notional / size, carried to 18 places -- more than any market's tick needs.
  const n = parseDecimal(notional);
  const s = parseDecimal(size);
  const scale = 18;
  return {
    size,
    price: formatDecimal({ units: (n.units * 10n ** BigInt(scale + s.scale)) / (s.units * 10n ** BigInt(n.scale)), scale }),
  };
}

/// Frames deliver an array, an object wrapping one under a known key, or a
/// single object.
function asArray<T>(contents: unknown, ...keys: string[]): T[] {
  if (Array.isArray(contents)) return contents as T[];
  if (contents && typeof contents === "object") {
    const record = contents as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (Array.isArray(value)) return value as T[];
      // positions snapshots are an object keyed by marketId.
      if (value && typeof value === "object") return Object.values(value) as T[];
    }
    if (keys.some((key) => key in record)) return [];
    return [contents as T];
  }
  return [];
}

/// Assign subaccounts to connections: fill each up to `cap` subscriptions
/// (channels x accounts) before opening the next.
export function planConnections(accounts: number, channelsPerAccount: number, cap: number): number[] {
  const perConnection = Math.max(1, Math.floor(cap / channelsPerAccount));
  const plan: number[] = [];
  for (let left = accounts; left > 0; left -= perConnection) plan.push(Math.min(perConnection, left));
  return plan;
}

// ---------------------------------------------------------------------------
// One socket
// ---------------------------------------------------------------------------

type FrameHandler = (frame: Record<string, unknown>) => void;

class StreamConnection {
  private socket?: WebSocket;
  private opening?: Promise<void>;
  private closed = false;
  private attempts = 0;
  private lastActivity = Date.now();
  private openedAt = 0;
  private timers: NodeJS.Timeout[] = [];

  /// Accounts this connection carries. Replayed with a fresh snapshot on every
  /// (re)connect.
  readonly accounts = new Map<string, AccountKey>();
  private readonly acked = new Set<string>();
  private readonly ackWaiters = new Map<string, Array<() => void>>();

  constructor(
    readonly id: number,
    private readonly onFrame: FrameHandler,
    private readonly onRotate: (connection: StreamConnection) => void,
  ) {}

  get subscriptionCount(): number {
    return this.accounts.size * ACCOUNT_CHANNELS.length;
  }

  connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.opening) return this.opening;

    this.opening = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(config.arcusWsUrl);
      this.socket = socket;

      socket.on("open", () => {
        this.opening = undefined;
        this.attempts = 0;
        this.openedAt = Date.now();
        this.lastActivity = Date.now();
        this.startTimers();
        log.info("connection open", { connection: this.id, accounts: this.accounts.size });
        for (const account of this.accounts.values()) this.sendSubscribe(account);
        resolve();
      });
      socket.on("message", (raw) => {
        this.lastActivity = Date.now();
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch (error) {
          log.warn("unparseable frame", errorFields(error));
          return;
        }
        if (frame.type === "subscribed") this.noteAck(frame);
        this.onFrame(frame);
      });
      socket.on("pong", () => {
        this.lastActivity = Date.now();
      });
      socket.on("error", (error) => {
        log.warn("socket error", { connection: this.id, ...errorFields(error) });
        if (this.opening) {
          this.opening = undefined;
          reject(error);
        }
      });
      socket.on("close", (code) => {
        this.stopTimers();
        this.acked.clear();
        if (this.socket === socket) this.socket = undefined;
        this.opening = undefined;
        if (this.closed) return;
        log.warn("connection closed; reconnecting", { connection: this.id, code });
        this.scheduleReconnect();
      });
    });
    return this.opening;
  }

  private startTimers(): void {
    this.stopTimers();
    this.timers.push(
      setInterval(() => {
        if (this.socket?.readyState !== WebSocket.OPEN) return;
        // WebSocket-level pings: Arcus documents no app-level heartbeat, and a
        // pong counts as activity for the staleness check below.
        this.socket.ping();
        if (Date.now() - this.lastActivity > STALE_AFTER_MS) {
          log.warn("connection stale; dropping it", { connection: this.id });
          this.socket.terminate(); // -> close -> reconnect
        }
        if (this.openedAt && Date.now() - this.openedAt > ROTATE_AFTER_MS) {
          this.openedAt = 0; // once
          this.onRotate(this);
        }
      }, PING_EVERY_MS),
    );
  }

  private stopTimers(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
  }

  private scheduleReconnect(): void {
    this.attempts += 1;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** (this.attempts - 1));
    const timer = setTimeout(() => {
      if (this.closed) return;
      this.connect().catch((error) => log.warn("reconnect failed", { connection: this.id, ...errorFields(error) }));
    }, delay);
    this.timers.push(timer);
  }

  private sendSubscribe(account: AccountKey): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    for (const channel of ACCOUNT_CHANNELS) {
      this.socket.send(
        JSON.stringify({
          type: "subscribe",
          channel,
          id: account.address.toLowerCase(),
          // Part of subscription identity -- omitting it silently means index 0.
          accountIndex: account.accountIndex,
          // Every (re)subscribe takes a snapshot, which is what the stream
          // reconciles missed events against (userFills replays up to 500).
          snapshot: true,
        }),
      );
    }
  }

  private noteAck(frame: Record<string, unknown>): void {
    const id = typeof frame.id === "string" ? frame.id.toLowerCase() : undefined;
    const channel = frame.channel as AccountChannel | undefined;
    const contents = frame.contents as Record<string, unknown> | undefined;
    const accountIndex = (frame.accountIndex ?? contents?.accountIndex) as number | undefined;
    if (!id || !channel) return;
    // Without an index on the frame, ack every index of that address on this
    // connection that has not been acked for this channel yet.
    const matches = [...this.accounts.values()].filter(
      (a) => a.address === id && (accountIndex === undefined || a.accountIndex === accountIndex),
    );
    for (const account of matches) {
      const channelKey = `${keyOf(account)}:${channel}`;
      if (this.acked.has(channelKey)) continue;
      this.acked.add(channelKey);
      if (ACCOUNT_CHANNELS.every((c) => this.acked.has(`${keyOf(account)}:${c}`))) {
        const waiters = this.ackWaiters.get(keyOf(account)) ?? [];
        this.ackWaiters.delete(keyOf(account));
        waiters.forEach((w) => w());
      }
      if (accountIndex === undefined) break;
    }
  }

  isAcked(account: AccountKey): boolean {
    return ACCOUNT_CHANNELS.every((c) => this.acked.has(`${keyOf(account)}:${c}`));
  }

  async add(account: AccountKey, waitForAck: boolean): Promise<void> {
    const key = keyOf(account);
    const known = this.accounts.has(key);
    this.accounts.set(key, account);
    await this.connect();
    if (!known) this.sendSubscribe(account);
    if (!waitForAck || this.isAcked(account)) return;

    await new Promise<void>((resolve, reject) => {
      const onAck = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.ackWaiters.set(key, (this.ackWaiters.get(key) ?? []).filter((w) => w !== onAck));
        reject(new TimeoutError(`Arcus subscriptions for ${key} were not acknowledged`));
      }, config.arcusRequestTimeoutMs);
      this.ackWaiters.set(key, [...(this.ackWaiters.get(key) ?? []), onAck]);
    });
  }

  close(): void {
    this.closed = true;
    this.stopTimers();
    this.socket?.close();
    this.socket = undefined;
  }
}

// ---------------------------------------------------------------------------
// Waiters
// ---------------------------------------------------------------------------

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
  clientId: string;
  orderId?: string;
  account: AccountKey;
  fills: Map<string, ArcusFill>;
  resolve: (outcome: OrderOutcome) => void;
  reject: (error: Error) => void;
  timers: NodeJS.Timeout[];
  settled: boolean;
}

interface TransferWaiter {
  account: AccountKey;
  type: AccountTransferUpdate["type"];
  /// Snapshot rows only count when created at or after this (epoch µs); live
  /// rows are new by definition.
  sinceMicros: bigint;
  match: (update: AccountTransferUpdate) => boolean;
  resolve: (update: AccountTransferUpdate) => void;
}

export type LiquidationFillHandler = (account: AccountKey, fill: ArcusFill) => void;
export type PositionFlatHandler = (account: AccountKey, row: Partial<ArcusPosition>) => void;

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

class ArcusStreamPool {
  private readonly connections: StreamConnection[] = [];
  private readonly assignment = new Map<string, StreamConnection>();
  private nextId = 1;
  private closed = false;

  private readonly orders = new Map<string, PendingOrder>();
  private readonly transferWaiters = new Set<TransferWaiter>();
  private liquidationHandlers: LiquidationFillHandler[] = [];
  private flatHandlers: PositionFlatHandler[] = [];

  onLiquidationFill(handler: LiquidationFillHandler): void {
    this.liquidationHandlers.push(handler);
  }

  onPositionFlat(handler: PositionFlatHandler): void {
    this.flatHandlers.push(handler);
  }

  private newConnection(): StreamConnection {
    const connection = new StreamConnection(
      this.nextId++,
      (frame) => this.onFrame(frame),
      (old) => void this.rotate(old),
    );
    this.connections.push(connection);
    return connection;
  }

  private connectionWithRoom(): StreamConnection {
    const room = this.connections.find(
      (c) => c.subscriptionCount + ACCOUNT_CHANNELS.length <= config.arcusStreamSubsPerConnection,
    );
    return room ?? this.newConnection();
  }

  /// Subscribe a subaccount (idempotent). `waitForAck` is for callers about to
  /// place an order: its fill must not race the subscription.
  async ensureSubscribed(address: string, accountIndex: number, waitForAck = true): Promise<void> {
    if (this.closed) throw new Error("Arcus stream is closed");
    const account = { address: address.toLowerCase(), accountIndex };
    const key = keyOf(account);
    let connection = this.assignment.get(key);
    if (!connection) {
      connection = this.connectionWithRoom();
      this.assignment.set(key, connection);
    }
    await connection.add(account, waitForAck);
  }

  /// Every slot, whatever its status. Called at boot and on an interval so new
  /// wallets join the pool without a restart.
  async syncSlots(): Promise<number> {
    const slots = await db.subaccountSlot.findMany({ include: { operatorWallet: true } });
    let added = 0;
    for (const slot of slots) {
      const key = keyOf({ address: slot.operatorWallet.address, accountIndex: slot.accountIndex });
      if (this.assignment.has(key)) continue;
      try {
        await this.ensureSubscribed(slot.operatorWallet.address, slot.accountIndex, false);
        added += 1;
      } catch (error) {
        log.warn("could not subscribe slot", { slotId: slot.id, ...errorFields(error) });
      }
    }
    if (added > 0) log.info("slots subscribed", { added, connections: this.connections.length });
    return added;
  }

  /// Replace a connection before Arcus's 24h cut-off: the new one is open and
  /// subscribed before the old one closes. Overlapping frames are harmless --
  /// fills dedupe on tradeId and every waiter resolves once.
  private async rotate(old: StreamConnection): Promise<void> {
    const replacement = new StreamConnection(this.nextId++, (frame) => this.onFrame(frame), (c) => void this.rotate(c));
    try {
      await Promise.all([...old.accounts.values()].map((account) => replacement.add(account, true)));
    } catch (error) {
      log.warn("rotation subscribe incomplete; closing old connection anyway", errorFields(error));
    }
    this.connections.push(replacement);
    for (const account of old.accounts.values()) this.assignment.set(keyOf(account), replacement);
    this.connections.splice(this.connections.indexOf(old), 1);
    old.close();
    log.info("connection rotated", { from: old.id, to: replacement.id });
  }

  // --- Routing -----------------------------------------------------------

  private onFrame(frame: Record<string, unknown>): void {
    const type = frame.type as string | undefined;
    if (type === "error") {
      log.warn("server error frame", { frame });
      return;
    }
    if (type !== "subscribed" && type !== "channel_data") return;

    const contents = frame.contents as Record<string, unknown> | undefined;
    const isSnapshot = type === "subscribed" || contents?.isSnapshot === true;
    const address = typeof frame.id === "string" ? frame.id.toLowerCase() : "";
    const accountIndex = (frame.accountIndex ?? contents?.accountIndex) as number | undefined;

    switch (frame.channel) {
      case "userFills":
        for (const raw of asArray<ArcusFill>(contents, "fills")) {
          if (!raw || !(raw as ArcusFill).tradeId) continue;
          const fill = normaliseFill(raw);
          this.onFill(fill);
          if (fill.liquidation) {
            const index = fill.accountIndex ?? accountIndex;
            for (const handler of this.liquidationHandlers) {
              handler({ address, accountIndex: index ?? -1 }, fill);
            }
          }
        }
        return;
      case "positions":
        if (isSnapshot) return; // snapshot rows are open positions; nothing to confirm
        if (contents && (contents.side === "FLAT" || (typeof contents.size === "string" && isZeroDecimal(contents.size)))) {
          for (const handler of this.flatHandlers) {
            handler({ address, accountIndex: accountIndex ?? -1 }, contents as Partial<ArcusPosition>);
          }
        }
        return;
      case "accountTransferUpdates":
        for (const raw of asArray<AccountTransferUpdate>(contents, "accountTransferEvents", "transfers")) {
          if (!raw?.type) continue;
          this.onTransfer({ address, accountIndex: accountIndex ?? -1 }, normaliseTransfer(raw), isSnapshot);
        }
        return;
      default:
        return;
    }
  }

  private findOrder(clientId?: string, orderId?: string): PendingOrder | undefined {
    if (clientId && this.orders.has(clientId)) return this.orders.get(clientId);
    if (!orderId) return undefined;
    for (const entry of this.orders.values()) if (entry.orderId === orderId) return entry;
    return undefined;
  }

  private onFill(fill: ArcusFill): void {
    const entry = this.findOrder(fill.clientId, fill.orderId);
    if (!entry || entry.settled) return;
    // Dedupe by tradeId: snapshot, live stream and a rotation overlap.
    if (entry.fills.has(fill.tradeId)) return;
    entry.fills.set(fill.tradeId, fill);
    if (!entry.orderId) entry.orderId = fill.orderId;
    // Fully filled is terminal even before any order-status read.
    if (fill.remainingSize !== undefined && isZeroDecimal(fill.remainingSize)) {
      this.settleFromFills(entry, "FILLED");
    }
  }

  private settleFromFills(entry: PendingOrder, status: string, extra: Partial<OrderOutcome> = {}): void {
    const fills = [...entry.fills.values()].sort((a, b) => a.createdAt - b.createdAt);
    const { size, price } = vwap(fills);
    this.finish(entry, {
      orderId: entry.orderId ?? "",
      clientId: entry.clientId,
      status,
      filledSize: size,
      averagePrice: price,
      fills,
      unfilled: compareDecimal(size, "0") === 0,
      ...extra,
    });
  }

  private finish(entry: PendingOrder, outcome: OrderOutcome): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.timers.forEach((t) => clearTimeout(t));
    this.orders.delete(entry.clientId);
    entry.resolve(outcome);
  }

  /// REST fallback: the order's own status. Settles on a terminal state, using
  /// the aggregate fill REST reports when the stream delivered no fill rows.
  private async pollOrder(entry: PendingOrder): Promise<void> {
    if (entry.settled || !entry.orderId) return;
    const status = await getOrderStatus(entry.account.address, entry.account.accountIndex, entry.orderId);
    if (!status || entry.settled) return;
    const terminal = status.status?.toUpperCase?.() ?? "";
    if (!TERMINAL_ORDER_STATUSES.has(terminal)) return;

    const filled = status.filledSize ?? "0";
    const streamed = vwap([...entry.fills.values()]);
    // Prefer the stream's per-fill rows when they account for the whole fill.
    if (entry.fills.size > 0 && compareDecimal(streamed.size, filled) >= 0) {
      this.settleFromFills(entry, terminal, { cancelReason: status.cancelReason, rejectReason: status.rejectReason });
      return;
    }
    this.finish(entry, {
      orderId: entry.orderId,
      clientId: entry.clientId,
      status: terminal,
      filledSize: isZeroDecimal(filled) ? "0" : filled,
      averagePrice: isZeroDecimal(filled) ? "0" : (status.avgFillPrice ?? "0"),
      fills: [...entry.fills.values()],
      unfilled: isZeroDecimal(filled),
      cancelReason: status.cancelReason,
      rejectReason: status.rejectReason,
    });
  }

  /**
   * Register interest in an order's outcome BEFORE placing it. `.outcome`
   * resolves on a terminal state -- from the stream, or the REST order-status
   * poll once `bindOrderId` has the id the ACK echoed.
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
      account: { address: params.address.toLowerCase(), accountIndex: params.accountIndex },
      fills: new Map(),
      resolve,
      reject,
      timers: [],
      settled: false,
    };
    entry.timers.push(
      setTimeout(async () => {
        if (entry.settled) return;
        try {
          await this.pollOrder(entry);
        } catch (error) {
          log.warn("final order poll failed", { clientId: entry.clientId, ...errorFields(error) });
        }
        if (entry.settled) return;
        // Partial fills before a timeout are still real -- hand them back.
        if (entry.fills.size > 0) {
          this.settleFromFills(entry, "TIMEOUT_PARTIAL");
          return;
        }
        entry.settled = true;
        entry.timers.forEach((t) => clearTimeout(t));
        this.orders.delete(entry.clientId);
        reject(new TimeoutError(`No outcome for order ${params.clientId} within ${timeoutMs}ms`));
      }, timeoutMs),
    );
    this.orders.set(params.clientId, entry);

    const schedulePoll = (delay: number) => {
      entry.timers.push(
        setTimeout(async () => {
          if (entry.settled) return;
          try {
            await this.pollOrder(entry);
          } catch (error) {
            log.debug("order poll failed", { clientId: entry.clientId, ...errorFields(error) });
          }
          if (!entry.settled) schedulePoll(config.arcusFallbackPollMs);
        }, delay),
      );
    };

    return {
      outcome,
      bindOrderId: (orderId: string) => {
        entry.orderId = orderId;
        schedulePoll(FIRST_ORDER_POLL_MS);
      },
      cancel: () => {
        if (entry.settled) return;
        entry.settled = true;
        entry.timers.forEach((t) => clearTimeout(t));
        this.orders.delete(params.clientId);
      },
    };
  }

  private onTransfer(account: AccountKey, update: AccountTransferUpdate, isSnapshot: boolean): void {
    for (const waiter of [...this.transferWaiters]) {
      if (waiter.account.address !== account.address) continue;
      const index = update.accountIndex ?? account.accountIndex;
      if (index !== -1 && index !== waiter.account.accountIndex) continue;
      if (update.type !== waiter.type) continue;
      if (update.status && update.status !== "APPLIED" && !update.status.startsWith("REJECTED")) continue;
      if (isSnapshot) {
        // Snapshot rows are history: only ones provably after the waiter's start count.
        if (!update.createdAt || BigInt(update.createdAt) < waiter.sinceMicros) continue;
      }
      if (!waiter.match(update)) continue;
      this.transferWaiters.delete(waiter);
      waiter.resolve(update);
    }
  }

  /**
   * Wait for one transfer event on a subaccount -- a DEPOSIT credit, a
   * WITHDRAWAL outcome. Resolves from the stream or from `poll` (REST), every
   * ARCUS_FALLBACK_POLL_MS, whichever sees it first. Resolves with REJECTED_*
   * rows too; the caller decides what a rejection means.
   */
  async awaitTransfer(params: {
    address: string;
    accountIndex: number;
    type: AccountTransferUpdate["type"];
    since: Date;
    match?: (update: AccountTransferUpdate) => boolean;
    timeoutMs: number;
    label: string;
  }): Promise<AccountTransferUpdate> {
    const account = { address: params.address.toLowerCase(), accountIndex: params.accountIndex };
    const sinceMicros = BigInt(params.since.getTime()) * 1000n;
    const match = params.match ?? (() => true);

    try {
      await this.ensureSubscribed(account.address, account.accountIndex, false);
    } catch (error) {
      log.warn("stream unavailable; waiting on REST only", { label: params.label, ...errorFields(error) });
    }

    let waiter: TransferWaiter | undefined;
    const fromStream = new Promise<AccountTransferUpdate>((resolve) => {
      waiter = { account, type: params.type, sinceMicros, match, resolve };
      this.transferWaiters.add(waiter);
    });

    let done = false;
    const fromRest = (async () => {
      const deadline = Date.now() + params.timeoutMs;
      while (!done && Date.now() < deadline) {
        try {
          const rows = await getAccountTransferUpdates(account.address, account.accountIndex, {
            limit: 50,
            from: sinceMicros,
          });
          const hit = rows
            .map(normaliseTransfer)
            .filter(
              (row) =>
                row.type === params.type &&
                (row.accountIndex === undefined || row.accountIndex === account.accountIndex) &&
                (row.status === "APPLIED" || row.status?.startsWith("REJECTED")) &&
                match(row),
            )
            .sort((a, b) => a.createdAt - b.createdAt)[0];
          if (hit) return hit;
        } catch (error) {
          log.debug("transfer poll failed", { label: params.label, ...errorFields(error) });
        }
        await sleep(config.arcusFallbackPollMs);
      }
      throw new TimeoutError(`${params.label} not seen within ${Math.round(params.timeoutMs / 1000)}s`);
    })();

    try {
      return await Promise.race([fromStream, fromRest]);
    } finally {
      done = true;
      if (waiter) this.transferWaiters.delete(waiter);
    }
  }

  close(): void {
    this.closed = true;
    for (const connection of this.connections.splice(0)) connection.close();
    this.assignment.clear();
  }

  stats(): { connections: number; accounts: number } {
    return { connections: this.connections.length, accounts: this.assignment.size };
  }
}

let instance: ArcusStreamPool | undefined;

export function getArcusStream(): ArcusStreamPool {
  if (!instance) instance = new ArcusStreamPool();
  return instance;
}

export function closeArcusStream(): void {
  instance?.close();
  instance = undefined;
}

/// Boot: subscribe every slot now, then pick up new ones every few minutes.
export function startArcusStream(): () => void {
  const stream = getArcusStream();
  const sync = () =>
    stream.syncSlots().catch((error) => log.error("slot subscription sync failed", errorFields(error)));
  void sync();
  const timer = setInterval(sync, 5 * 60_000);
  return () => clearInterval(timer);
}

export type { ArcusStreamPool, AccountKey };
