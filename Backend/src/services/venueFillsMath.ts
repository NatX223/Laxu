import { formatDecimal } from "../lib/decimal";
import type { ApiFill, ApiPosition } from "../venue/perpl/types";

/**
 * Which of a slot's Perpl fills belong to one Laxu position, and how to show
 * them. Pure: venueFills.ts does the fetching.
 *
 * A slot (one Perpl account) is reused across positions, and Perpl's history
 * endpoints cannot filter, so matching is ours. A fill carries the order id
 * (`oid`) but no request id, so the key is the set of order ids that touched
 * this position:
 *
 *   1. the oids we saved (entry order, ledger rows);
 *   2. plus every oid in Perpl's position history under this position's `pid`
 *      (the `pid` we saved, or the one the entry order's event names) -- this
 *      is what finds the close and reduce orders we never stored;
 *   3. only when neither gives a single oid: account + market + time window.
 */

export type MatchMethod = "order-ids" | "time-window";

export interface MatchKeys {
  accountId: string;
  marketId: number;
  /// Perpl `pid`, if saved.
  pid: string | null;
  /// Order ids saved on our rows.
  knownOrderIds: string[];
  /// Window for the fallback, ms (already padded).
  fromMs: number;
  toMs: number;
}

export interface PositionOrders {
  pid: string | null;
  orderIds: Set<string>;
  /// Position-history events under `pid`, newest first.
  events: ApiPosition[];
}

const sameAccount = (keys: MatchKeys, acc: number, mkt: number) => String(acc) === keys.accountId && mkt === keys.marketId;

/// Steps 1-2: every order id known to belong to the position.
export function positionOrders(history: ApiPosition[], keys: MatchKeys): PositionOrders {
  const known = new Set(keys.knownOrderIds.filter((id) => id !== "" && id !== "0"));
  const own = history.filter((e) => sameAccount(keys, e.acc, e.mkt));
  const pid = keys.pid ?? own.find((e) => e.oid !== undefined && known.has(String(e.oid)))?.pid?.toString() ?? null;
  const events = pid === null ? [] : own.filter((e) => String(e.pid) === pid);
  const orderIds = new Set(known);
  for (const e of events) if (e.oid) orderIds.add(String(e.oid));
  return { pid, orderIds, events };
}

/// Step 3 too: the fills that belong to the position, newest first.
export function matchFills(fills: ApiFill[], keys: MatchKeys, orderIds: Set<string>): { fills: ApiFill[]; matchedBy: MatchMethod } {
  const own = fills.filter((f) => sameAccount(keys, f.acc, f.mkt));
  if (orderIds.size > 0) return { fills: own.filter((f) => orderIds.has(String(f.oid))), matchedBy: "order-ids" };
  return {
    fills: own.filter((f) => f.at?.t !== undefined && f.at.t >= keys.fromMs && f.at.t <= keys.toMs),
    matchedBy: "time-window",
  };
}

/// True once a newest-first page reaches past `fromMs` -- the walk can stop.
export function reachedBefore(items: Array<{ at?: { t?: number } }>, fromMs: number): boolean {
  const last = items[items.length - 1]?.at?.t;
  return last !== undefined && last < fromMs;
}

export interface VenueFill {
  /// Stable key: block, tx index, log index, order id.
  fillId: string;
  /// ISO time of the block.
  time: string | null;
  side: "buy" | "sell";
  /// "open" | "close": what the order did to the position.
  action: "open" | "close";
  sizeHuman: string;
  priceHuman: string | null;
  /// Collateral (AUSD). Gross: includes any builder fee. Negative = rebate.
  feeHuman: string;
  /// Builder-fee portion of `feeHuman`, only when non-zero.
  builderFeeHuman?: string;
  liquiditySide: "maker" | "taker" | "unknown";
  orderId: string;
  /// 0x-prefixed; absent when Perpl gave none.
  txHash?: string;
  blockNumber?: number;
}

export interface FillScales {
  priceDecimals: number;
  sizeDecimals: number;
  /// Collateral decimals of API Amounts (`getExchangeInfo().collateralDecimals`).
  cnsDecimals: number;
}

// OrderType: 1 OpenLong, 2 OpenShort, 3 CloseLong, 4 CloseShort.
const SIDE: Record<number, VenueFill["side"]> = { 1: "buy", 2: "sell", 3: "sell", 4: "buy" };

export function amountHuman(amount: string | undefined, decimals: number): string {
  const text = (amount ?? "0").trim();
  if (!/^-?\d+$/.test(text)) return "0";
  return formatDecimal({ units: BigInt(text), scale: decimals });
}

/// `at.txid` as a 0x hash, or undefined for anything that isn't 32 bytes of hex.
export function txHashOf(txid: string | undefined): string | undefined {
  if (!txid) return undefined;
  const hex = txid.startsWith("0x") ? txid.slice(2) : txid;
  return /^[0-9a-fA-F]{64}$/.test(hex) ? `0x${hex.toLowerCase()}` : undefined;
}

export function toVenueFill(fill: ApiFill, scales: FillScales): VenueFill {
  const at = fill.at ?? {};
  const builderFee = fill.bfa && fill.bfa !== "0" ? amountHuman(fill.bfa, scales.cnsDecimals) : undefined;
  const txHash = txHashOf(at.txid);
  return {
    fillId: `${at.b ?? "?"}:${at.tx ?? "?"}:${at.l ?? "?"}:${fill.oid}`,
    time: at.t ? new Date(at.t).toISOString() : null,
    side: SIDE[fill.t] ?? "buy",
    action: fill.t === 3 || fill.t === 4 ? "close" : "open",
    sizeHuman: formatDecimal({ units: BigInt(fill.s), scale: scales.sizeDecimals }),
    priceHuman: fill.p === undefined ? null : formatDecimal({ units: BigInt(fill.p), scale: scales.priceDecimals }),
    feeHuman: amountHuman(fill.f, scales.cnsDecimals),
    ...(builderFee && builderFee !== "0" ? { builderFeeHuman: builderFee } : {}),
    liquiditySide: fill.l === 1 ? "maker" : fill.l === 2 ? "taker" : "unknown",
    orderId: String(fill.oid),
    ...(txHash ? { txHash } : {}),
    ...(at.b !== undefined ? { blockNumber: at.b } : {}),
  };
}

/// Realised funding over the position's events, collateral units (positive = received).
export function realisedFunding(events: ApiPosition[], cnsDecimals: number): string {
  let total = 0n;
  for (const e of events) if (e.fnd && /^-?\d+$/.test(e.fnd)) total += BigInt(e.fnd);
  return formatDecimal({ units: total, scale: cnsDecimals });
}
