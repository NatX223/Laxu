import type { Address, Hash } from "viem";

import { db } from "../../config/db";
import { config } from "../../config/env";
import { createLogger } from "../../lib/logger";
import { credentialsFor, slotWallet, type SlotWithWallet } from "../../services/allocator";
import type { ResolvedMarket } from "../../services/markets";
import type { OrderOutcome, OrderSide, SendHooks, VenueAdapter, VenuePosition } from "../types";
import { describeOrderReason, OrderFlags, OrderStatus, OrderType } from "./config";
import { ensure } from "./connections";
import {
  allowOrderForwarding,
  depositCollateral,
  ensureExchangeApproval,
  getAccountByAddr,
  getPosition,
  withdrawCollateral,
} from "./exchange";
import { getOrderHistory, getTicker, walkHistory } from "./rest";
import { settleOrderEvents, type OrderKind, type RawOrderResult } from "./tradingWs";
import type { ApiOrder, OrderSpec } from "./types";
import {
  apiAmountToAsset,
  assetToApiAmount,
  assetToCns,
  chainTypeToDirection,
  cnsToAsset,
  collateralScale,
  lotsToSize6,
  pnsToPrice18,
  size6ToLots,
} from "./units";

const log = createLogger("perpl:adapter");

const ORDER_TYPE: Record<OrderSide, number> = {
  open_long: OrderType.OpenLong,
  open_short: OrderType.OpenShort,
  close_long: OrderType.CloseLong,
  close_short: OrderType.CloseShort,
};

/// An allowance at or above this is "approved for MAX" -- re-approving below
/// it costs one transaction, never a failed deposit.
const APPROVED = 2n ** 128n;

/// How many order-history pages a lookup walks before giving up.
const HISTORY_PAGES = 5;

function accountIdOf(slot: SlotWithWallet): bigint {
  if (!slot.perplAccountId) throw new Error(`Slot ${slot.id} has no Perpl account yet (run slots:provision)`);
  return BigInt(slot.perplAccountId);
}

function maxBig(...values: bigint[]): bigint {
  return values.reduce((max, value) => (value > max ? value : max));
}

/**
 * Perpl, behind the venue-agnostic interface. One wallet = one Perpl account
 * = one slot. Money moves on-chain from the slot wallet (deposit / withdraw are
 * credited in the same transaction); orders go over the slot's trading socket;
 * positions are read on-chain, from the very view PerplReader gives the
 * contracts, so the backend and the token agree by construction.
 */
export class PerplAdapter implements VenueAdapter {
  /// Highest `rq` handed out per slot in this process -- so two flows on one
  /// slot never get the same id between nextRequest and their DB write.
  private handedOut = new Map<string, bigint>();

  async ensureAccountReady(slot: SlotWithWallet): Promise<void> {
    const accountId = accountIdOf(slot);
    const owner = slot.operatorWallet.address as Address;
    const info = await getAccountByAddr(owner);
    if (info.accountId !== accountId) {
      throw new Error(`Perpl account for ${owner} is ${info.accountId}, slot ${slot.id} records ${accountId}`);
    }
    if (info.frozen !== 0) throw new Error(`Perpl account ${accountId} is frozen (${info.frozen})`);

    const wallet = slotWallet(slot);
    await ensureExchangeApproval(wallet, APPROVED);

    const connection = ensure(slot);
    await connection.ready();
    if (!connection.accountState()?.fw) {
      // Idempotent; the change shows up on the next mt:21.
      await allowOrderForwarding(wallet, true);
      log.info("order forwarding enabled", { slotId: slot.id, accountId: accountId.toString() });
    }
    if (!slot.forwardingEnabled) {
      await db.subaccountSlot.update({ where: { id: slot.id }, data: { forwardingEnabled: true } });
    }
  }

  /**
   * Free balance: the account's balance less what open orders lock. Margin
   * posted to a position is not part of `balanceCNS`.
   * VERIFY(spec03): that `balanceCNS` excludes position deposits and that
   * `lockedBalanceCNS` is only order locks (zero with IOC-only trading).
   */
  async accountBalance(slot: SlotWithWallet): Promise<bigint> {
    const [info, scale] = await Promise.all([
      getAccountByAddr(slot.operatorWallet.address as Address),
      collateralScale(),
    ]);
    const free = info.balanceCNS > info.lockedBalanceCNS ? info.balanceCNS - info.lockedBalanceCNS : 0n;
    return cnsToAsset(free, scale);
  }

  async deposit(slot: SlotWithWallet, amount: bigint, hooks: SendHooks = {}): Promise<Hash> {
    const scale = await collateralScale();
    const cns = assetToCns(amount, scale);
    if (cns <= 0n) throw new Error(`deposit of ${amount} asset units is below one collateral unit`);
    const wallet = slotWallet(slot);
    await ensureExchangeApproval(wallet, amount);
    const txHash = await depositCollateral(wallet, cns, { onSent: hooks.onSent });
    log.info("deposited into the Perpl account", { slotId: slot.id, amount: amount.toString(), txHash });
    return txHash;
  }

  async withdraw(slot: SlotWithWallet, amount: bigint, hooks: SendHooks = {}): Promise<Hash> {
    const scale = await collateralScale();
    const cns = assetToCns(amount, scale);
    if (cns <= 0n) throw new Error(`withdrawal of ${amount} asset units is below one collateral unit`);
    const txHash = await withdrawCollateral(slotWallet(slot), cns, { onSent: hooks.onSent });
    log.info("withdrew from the Perpl account", { slotId: slot.id, amount: amount.toString(), txHash });
    return txHash;
  }

  async placeMarketOrder(
    slot: SlotWithWallet,
    params: {
      market: ResolvedMarket;
      side: OrderSide;
      size6: bigint;
      leverage: number;
      requestId: bigint;
      lastExecBlock: bigint;
    },
  ): Promise<OrderOutcome> {
    const { market } = params;
    const lots = size6ToLots(params.size6, market.sizeDecimals);
    if (lots <= 0n) throw new Error(`order size ${params.size6} (size6) is below one lot on ${market.symbol}`);
    // Close orders (t:3/4) are reduce-only by definition and clamp to the position.
    const spec: OrderSpec = {
      rq: Number(params.requestId),
      mkt: market.venueMarketId,
      acc: Number(accountIdOf(slot)),
      t: ORDER_TYPE[params.side],
      p: 0,
      s: Number(lots),
      fl: OrderFlags.ImmediateOrCancel,
      ms: Math.min(config.perplSlippageBps, market.maxSlippageBps),
      lv: Math.round(params.leverage * 100),
      lb: Number(params.lastExecBlock),
      // `mnp` omitted on purpose: the market default applies (an explicit 0
      // would refuse any fill that collateralizes negative PnL).
    };
    const raw = await ensure(slot).sendOrder(spec, "ioc");
    const outcome = await this.toOutcome(raw, params.requestId, market, "ioc");
    log.info("market order outcome", {
      slotId: slot.id,
      market: market.symbol,
      side: params.side,
      rq: params.requestId.toString(),
      status: outcome.status,
      filledSize6: outcome.filledSize6.toString(),
      reason: outcome.reason,
    });
    return outcome;
  }

  async addPositionMargin(
    slot: SlotWithWallet,
    params: { market: ResolvedMarket; amount: bigint; requestId: bigint; lastExecBlock: bigint },
  ): Promise<OrderOutcome> {
    const scale = await collateralScale();
    const spec: OrderSpec = {
      rq: Number(params.requestId),
      mkt: params.market.venueMarketId,
      acc: Number(accountIdOf(slot)),
      t: OrderType.IncreasePositionCollateral,
      p: 0,
      s: 0,
      // VERIFY(spec03): the unit of `a` (CNS integer vs human decimal) -- see
      // units.parseApiAmount.
      a: assetToApiAmount(params.amount, scale),
      fl: OrderFlags.GoodTillCancel,
      lv: 0,
      lb: Number(params.lastExecBlock),
    };
    const raw = await ensure(slot).sendOrder(spec, "instant");
    return this.toOutcome(raw, params.requestId, params.market, "instant");
  }

  async nextRequest(
    slot: SlotWithWallet,
    market: ResolvedMarket,
  ): Promise<{ requestId: bigint; lastExecBlock: bigint }> {
    const connection = ensure(slot);
    await connection.ready();
    const row = await db.subaccountSlot.findUniqueOrThrow({ where: { id: slot.id }, select: { lastRequestId: true } });
    const lfr = BigInt(connection.accountState()?.lfr ?? 0);
    const requestId = maxBig(lfr, BigInt(row.lastRequestId), this.handedOut.get(slot.id) ?? 0n) + 1n;
    this.handedOut.set(slot.id, requestId);
    const head = await connection.currentHead();
    return { requestId, lastExecBlock: head + BigInt(Math.max(1, market.orderTtlBlocks)) };
  }

  /**
   * The socket's own cache first, then the account's order history. Found:
   * its outcome. Not found: `pending` while `head < lb` (it may still execute
   * -- the caller waits, never resends with a NEW rq), `not_placed` once
   * `head >= lb` (it can no longer execute -- a new rq is safe).
   *
   * VERIFY(spec03): how quickly order-history reflects an order's mt:24
   * events. The docs make `head >= lb` with nothing heard a safe "not placed"
   * only when every heartbeat since posting was observed; the history lookup
   * is what stands in for that across reconnects and restarts.
   */
  async findOrderOutcome(
    slot: SlotWithWallet,
    requestId: bigint,
    lastExecBlock: bigint,
    options: { market?: ResolvedMarket; kind?: OrderKind } = {},
  ): Promise<OrderOutcome | "pending" | "not_placed"> {
    const kind = options.kind ?? "ioc";
    const connection = ensure(slot);
    const seen = connection.seenOrder(requestId, kind);
    if (seen?.done && seen.order) {
      return this.toOutcome({ kind: "order", order: seen.order }, requestId, options.market, kind);
    }

    const target = Number(requestId);
    const accountId = Number(accountIdOf(slot));
    const events = (
      await walkHistory(
        (page) => getOrderHistory(credentialsFor(slot), page),
        // Request ids only grow per account: once a page reaches below ours,
        // older pages cannot hold it.
        (items) => items.some((order) => order.acc === accountId && order.rq < target),
        HISTORY_PAGES,
      )
    )
      .filter((order) => order.acc === accountId && order.rq === target)
      // History is newest -> oldest; the dedupe wants arrival order.
      .reverse();

    const head = await connection.currentHead();
    if (events.length > 0) {
      const settled = settleOrderEvents(events, kind);
      if (settled.order && (settled.done || head >= lastExecBlock)) {
        return this.toOutcome({ kind: "order", order: settled.order }, requestId, options.market, kind);
      }
      return "pending";
    }
    return head < lastExecBlock ? "pending" : "not_placed";
  }

  async getPosition(slot: SlotWithWallet, market: ResolvedMarket): Promise<VenuePosition> {
    const [{ position, markPricePNS, markPriceValid }, scale] = await Promise.all([
      getPosition(BigInt(market.perpetualId), accountIdOf(slot)),
      collateralScale(),
    ]);
    const exists = position.lotLNS > 0n;
    const depositAsset = cnsToAsset(position.depositCNS, scale);
    const pnlAsset = cnsToAsset(position.pnlCNS, scale);
    const premiumAsset = cnsToAsset(position.premiumPnlCNS, scale);
    return {
      exists,
      direction: exists ? chainTypeToDirection(position.positionType) : "long",
      size6: lotsToSize6(position.lotLNS, market.sizeDecimals),
      entry18: pnsToPrice18(position.pricePNS, market.priceDecimals),
      depositAsset,
      pnlAsset,
      premiumAsset,
      // VERIFY(spec03): whether pnlCNS already includes premiumPnlCNS; if it
      // does, drop premiumAsset here. (PerplReader.venueEquity uses
      // depositCNS + pnlCNS only.)
      equityAsset: exists ? depositAsset + pnlAsset + premiumAsset : 0n,
      mark18: pnsToPrice18(markPricePNS, market.priceDecimals),
      markValid: markPriceValid,
    };
  }

  async markPrice(market: ResolvedMarket): Promise<bigint> {
    const ticker = await getTicker(market.venueMarketId);
    const state = ticker.d[String(market.venueMarketId)];
    const mark = state?.mrk && state.mrk > 0 ? state.mrk : state?.orl;
    if (!mark || mark <= 0) throw new Error(`Perpl has no mark price for ${market.symbol} yet`);
    return pnsToPrice18(mark, market.priceDecimals);
  }

  // --- conversions --------------------------------------------------------------------

  private async marketFor(order: ApiOrder, market?: ResolvedMarket): Promise<Pick<ResolvedMarket, "priceDecimals" | "sizeDecimals">> {
    if (market) return market;
    const row = await db.market.findUnique({ where: { venueMarketId: order.mkt } });
    if (!row) throw new Error(`order ${order.oid} is on unknown Perpl market ${order.mkt}`);
    return row;
  }

  private async toOutcome(
    raw: RawOrderResult,
    requestId: bigint,
    market: ResolvedMarket | undefined,
    kind: OrderKind,
  ): Promise<OrderOutcome> {
    if (raw.kind === "rejected") {
      return {
        status: "failed",
        requestId,
        filledSize6: 0n,
        avgPrice18: 0n,
        feeAsset: 0n,
        reason: `gateway rejected (${raw.code}): ${raw.reason}`,
      };
    }
    const order = raw.order;
    const decimals = await this.marketFor(order, market);
    const scale = await collateralScale();
    const filledLots = BigInt(order.fs ?? 0);
    const base = {
      requestId,
      orderId: order.oid !== undefined ? String(order.oid) : undefined,
      filledSize6: lotsToSize6(filledLots, decimals.sizeDecimals),
      avgPrice18: filledLots > 0n && order.fp ? pnsToPrice18(order.fp, decimals.priceDecimals) : 0n,
      feeAsset: apiAmountToAsset(order.f, scale),
      reason: describeOrderReason(order.sr, order.fr),
    };

    if (order.st === OrderStatus.Failed) return { ...base, status: "failed" };
    // IncreasePositionCollateral: any non-failure status means it was applied.
    // VERIFY(spec03): which status Perpl reports for a t:6 order.
    if (kind === "instant") return { ...base, status: "filled" };
    if (order.st === OrderStatus.Filled) return { ...base, status: "filled" };
    if (filledLots > 0n) {
      const full = order.os !== undefined && order.os > 0 && filledLots >= BigInt(order.os);
      return { ...base, status: full ? "filled" : "partial" };
    }
    return { ...base, status: "unfilled" };
  }
}
