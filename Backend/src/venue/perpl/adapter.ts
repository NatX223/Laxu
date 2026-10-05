import type { Address, Hash } from "viem";

import { publicClient } from "../../chain/clients";
import { db } from "../../config/db";
import { config } from "../../config/env";
import { sleep } from "../../lib/async";
import { alert, createLogger, errorFields } from "../../lib/logger";
import { credentialsFor, slotWallet, type SlotWithWallet } from "../../services/allocator";
import { maxLeverage, type ResolvedMarket } from "../../services/markets";
import type { OrderOutcome, OrderSide, SendHooks, SentRequest, VenueAdapter, VenuePosition } from "../types";
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
import { getPositions, getTicker } from "./rest";
import { type OrderKind, type RawOrderResult } from "./tradingWs";
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

/// How long a t:6 waits for the chain to pass its `lb` before reporting unknown.
const CHAIN_PAST_LB_TIMEOUT_MS = 60_000;

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
   */
  // Confirmed on testnet 2026-10-05: an open moves exactly depositCNS + fee out of balanceCNS; lockedBalanceCNS stays 0 with IOC-only trading (docs/perpl-findings.md#v-adapter-98)
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
    // Perpl never rejects a too-high `lv` -- it silently clamps it to the
    // market max, so the order would need more margin than we sized for.
    const limit = maxLeverage(market);
    if (!Number.isInteger(params.leverage) || params.leverage < 1 || params.leverage > limit) {
      throw new Error(`leverage ${params.leverage}x is outside 1..${limit}x on ${market.symbol}; not sending`);
    }
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
    if (outcome.filledSize6 > 0n) await this.checkPositionLeverage(slot, market, spec.lv);
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
    const accountId = accountIdOf(slot);
    const before = (await getPosition(BigInt(params.market.perpetualId), accountId)).position.depositCNS;
    const spec: OrderSpec = {
      rq: Number(params.requestId),
      mkt: params.market.venueMarketId,
      acc: Number(accountId),
      t: OrderType.IncreasePositionCollateral,
      p: 0,
      s: 0,
      // Confirmed on testnet 2026-10-05: `a` is a CNS integer string -- "5000000" moved depositCNS by exactly $5 (docs/perpl-findings.md#v-adapter-185)
      a: assetToApiAmount(params.amount, scale),
      fl: OrderFlags.GoodTillCancel,
      lv: 0,
      lb: Number(params.lastExecBlock),
    };
    let raw: RawOrderResult | undefined;
    try {
      raw = await ensure(slot).sendOrder(spec, "instant");
    } catch (error) {
      // No verdict on the socket is normal for a t:6 -- the chain decides below.
      log.debug("t:6 had no socket verdict; reading depositCNS", { slotId: slot.id, ...errorFields(error) });
    }
    if (raw?.kind === "rejected") return this.toOutcome(raw, params.requestId, params.market, "instant");

    // Confirmed on testnet 2026-10-05: a successful t:6 sends no success mt:24, only a later st:7/sr:32 -- so the on-chain depositCNS decides (docs/perpl-findings.md#v-adapter-334)
    await this.waitForChainPast(params.lastExecBlock, CHAIN_PAST_LB_TIMEOUT_MS);
    const after = (await getPosition(BigInt(params.market.perpetualId), accountId)).position.depositCNS;
    const added = after > before ? after - before : 0n;
    return {
      status: added > 0n ? "filled" : "unfilled",
      requestId: params.requestId,
      filledSize6: 0n,
      avgPrice18: 0n,
      feeAsset: 0n,
      reason: `depositCNS ${before} -> ${after}`,
    };
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
   * The socket's verdict when it heard one; otherwise the lot rule, decided
   * on-chain once the chain is past `lb` (no order can execute after it):
   *
   *   size changed   -> filled, by |size now - size before|
   *   size unchanged -> `not_placed`: a NEW rq is safe
   *
   * The price of a fill seen only this way comes from the chain too: the
   * weighted entry for an add, the on-chain mark for a reduce (marked as an
   * estimate in `reason`). Callers hold the slot lock for the whole order, so
   * nothing else moves the size in between.
   */
  // Confirmed on testnet 2026-10-05: order-history shows an order ~22-27 s after the socket does -- too late to decide "not placed" 6 s after lb, so it is not used (docs/perpl-findings.md#v-adapter-216)
  async findOrderOutcome(
    slot: SlotWithWallet,
    request: SentRequest,
    market: ResolvedMarket,
  ): Promise<OrderOutcome | "pending" | "not_placed"> {
    const seen = ensure(slot).seenOrder(request.requestId, "ioc");
    if (seen?.done && seen.order) {
      return this.toOutcome({ kind: "order", order: seen.order }, request.requestId, market, "ioc");
    }
    if ((await publicClient().getBlockNumber()) <= request.lastExecBlock) return "pending";

    const now = await this.getPosition(slot, market);
    const sizeNow = now.exists ? now.size6 : 0n;
    const delta = sizeNow > request.size6Before ? sizeNow - request.size6Before : request.size6Before - sizeNow;
    if (delta === 0n) return "not_placed";

    const grew = sizeNow > request.size6Before;
    const avgPrice18 = grew
      ? (now.entry18 * sizeNow - request.entry18Before * request.size6Before) / delta
      : now.mark18;
    log.warn("order resolved from the on-chain lot delta", {
      slotId: slot.id,
      rq: request.requestId.toString(),
      sizeBefore: request.size6Before.toString(),
      sizeNow: sizeNow.toString(),
    });
    return {
      status: "filled",
      requestId: request.requestId,
      filledSize6: delta,
      avgPrice18,
      feeAsset: 0n,
      reason: grew ? "resolved on-chain (lot delta)" : "resolved on-chain (lot delta); exit price estimated from the mark",
    };
  }

  /// Polls the RPC until its head is past `block`.
  private async waitForChainPast(block: bigint, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((await publicClient().getBlockNumber()) <= block) {
      if (Date.now() > deadline) throw new Error(`chain not past block ${block} after ${timeoutMs}ms`);
      await sleep(500);
    }
  }

  /**
   * After a fill: the venue position's `lv` must be what we sent. Perpl
   * re-margins the WHOLE position to each order's `lv` (docs/perpl-findings.md#f-remargin),
   * so a mismatch means the position was re-levered. Alert, never throw -- the
   * fill already happened and a throw would invite a second order.
   */
  private async checkPositionLeverage(slot: SlotWithWallet, market: ResolvedMarket, lv: number): Promise<void> {
    try {
      const { d } = await getPositions(credentialsFor(slot));
      const open = (d ?? []).find((p) => p.mkt === market.venueMarketId && p.st === 1);
      if (open && open.lv !== undefined && open.lv !== lv) {
        alert("venue position leverage differs from the order's", {
          slotId: slot.id,
          market: market.symbol,
          sent: lv,
          position: open.lv,
        });
      }
    } catch (error) {
      log.warn("could not check the position's leverage", { slotId: slot.id, ...errorFields(error) });
    }
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
      // Confirmed on testnet 2026-10-05: pnlCNS already includes premiumPnlCNS (103880 = 104580 - 700), so equity is depositCNS + pnlCNS, as PerplReader.venueEquity (docs/perpl-findings.md#v-adapter-277)
      equityAsset: exists ? depositAsset + pnlAsset : 0n,
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
    // t:6 is never decided here (addPositionMargin reads depositCNS); only a
    // gateway rejection reaches this point for it.
    if (kind === "instant") return { ...base, status: "unfilled" };
    if (order.st === OrderStatus.Filled) return { ...base, status: "filled" };
    if (filledLots > 0n) {
      const full = order.os !== undefined && order.os > 0 && filledLots >= BigInt(order.os);
      return { ...base, status: full ? "filled" : "partial" };
    }
    return { ...base, status: "unfilled" };
  }
}
