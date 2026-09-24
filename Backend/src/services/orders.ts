import { placeOrder } from "../arcus/client";
import type { ArcusCredentials, OrderSide } from "../arcus/types";
import { config } from "../config/env";
import { applyBps, ceilToStep, floorToStep } from "../lib/decimal";
import { getArcusStream, type OrderOutcome } from "./arcusStream";
import { markPriceFor, type ResolvedMarket } from "./markets";

/**
 * A MARKET + IOC order and its outcome. The shared stream is subscribed and
 * the waiter registered BEFORE the REST call -- placeOrder answers 202 ACK with
 * no fill data, so attaching afterwards would race the fill.
 */
export async function placeMarketOrder(params: {
  credentials: ArcusCredentials;
  market: ResolvedMarket;
  side: OrderSide;
  /// Human base quantity, already on the market's step grid.
  quantity: string;
  reduceOnly?: boolean;
  /// Saved by the caller before this runs, so a restart can recognise the fill.
  clientId: string;
}): Promise<OrderOutcome> {
  const { credentials, market, side, clientId } = params;

  // MARKET orders take `price` as a protective slippage bound within 10% of
  // mark: a BUY bound above mark floors to the tick, a SELL bound below ceils.
  const mark = await markPriceFor(market);
  const bound =
    side === "BUY" ? applyBps(mark, config.arcusSlippageBps, 18) : applyBps(mark, -config.arcusSlippageBps, 18);
  const price = side === "BUY" ? floorToStep(bound, market.tickSize) : ceilToStep(bound, market.tickSize);

  const stream = getArcusStream();
  await stream.ensureSubscribed(credentials.address, credentials.accountIndex);
  const waiter = stream.expectOrder({
    address: credentials.address,
    accountIndex: credentials.accountIndex,
    clientId,
  });

  let result;
  try {
    result = await placeOrder(credentials, {
      marketId: market.arcusMarketId,
      side,
      orderType: "MARKET",
      timeInForce: "IOC",
      quantity: params.quantity,
      price,
      reduceOnly: params.reduceOnly ?? false,
      clientId,
      tickSize: market.tickSize,
      stepSize: market.stepSize,
    });
  } catch (error) {
    waiter.cancel();
    throw error;
  }
  waiter.bindOrderId(result.orderId);
  return waiter.outcome;
}

/// Arcus client ids are capped at 36 characters.
export function clientIdFor(prefix: string, seed: string): string {
  return `${prefix}${seed.replace(/^0x/, "").slice(0, 20)}${Date.now().toString(36)}`.slice(0, 36);
}
