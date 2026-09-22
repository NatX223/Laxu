import axios, { AxiosError, type AxiosInstance } from "axios";

import { config } from "../config/env";
import { divideExact } from "../lib/decimal";
import { ArcusError } from "../lib/errors";
import { createLogger } from "../lib/logger";
import {
  OrderSignOp,
  OrderSignSide,
  OrderSignTif,
  signArcusRequest,
  signedHeaders,
  unixNanos,
  type PlaceOrderSignPayload,
} from "./signing";
import type {
  AccountTransferUpdate,
  AdjustIsolatedMarginResult,
  ArcusAccount,
  ArcusCredentials,
  ArcusMarketInfo,
  ArcusPosition,
  PlaceOrderParams,
  PlaceOrderResult,
} from "./types";

const log = createLogger("arcus:rest");

function http(): AxiosInstance {
  return axios.create({
    baseURL: config.arcusApiBaseUrl,
    timeout: config.arcusRequestTimeoutMs,
    headers: { "Content-Type": "application/json" },
    // Arcus returns 200/202 on success and encodes rejections in the body for
    // some routes; surface everything below 500 to the caller for inspection.
    validateStatus: (status) => status < 500,
  });
}

const client = http();

function fail(action: string, error: unknown): never {
  if (error instanceof AxiosError) {
    throw new ArcusError(
      `${action} failed: ${error.message}`,
      error.response?.status,
      error.response?.data,
    );
  }
  throw new ArcusError(`${action} failed: ${String(error)}`);
}

function expectOk<T>(action: string, status: number, data: T): T {
  if (status >= 400) {
    throw new ArcusError(`${action} rejected with HTTP ${status}`, status, data);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Public reads. No signature required -- account-scoped reads on Arcus are
// authenticated by `?address=` alone, and the API key authorises writes only.
// ---------------------------------------------------------------------------

export async function getMarkets(market?: string): Promise<ArcusMarketInfo[]> {
  try {
    const res = await client.get("/v1/markets", { params: market ? { market } : undefined });
    const body = expectOk("getMarkets", res.status, res.data);
    return Array.isArray(body) ? body : ((body as { markets?: ArcusMarketInfo[] }).markets ?? []);
  } catch (error) {
    return fail("getMarkets", error);
  }
}

export async function getAccount(
  address: string,
  accountIndex: number,
): Promise<ArcusAccount | null> {
  try {
    const res = await client.get("/v1/account", { params: { address, accountIndex } });
    // A subaccount with no activity yet is a 404, not an error condition.
    if (res.status === 404) return null;
    return expectOk("getAccount", res.status, res.data) as ArcusAccount;
  } catch (error) {
    return fail("getAccount", error);
  }
}

export async function getPositions(
  address: string,
  accountIndex: number,
): Promise<ArcusPosition[]> {
  try {
    const res = await client.get("/v1/positions", { params: { address, accountIndex } });
    if (res.status === 404) return [];
    const body = expectOk("getPositions", res.status, res.data);
    return Array.isArray(body) ? body : ((body as { positions?: ArcusPosition[] }).positions ?? []);
  } catch (error) {
    return fail("getPositions", error);
  }
}

export async function getAccountTransferUpdates(
  address: string,
  accountIndex: number,
  options: { limit?: number; from?: bigint } = {},
): Promise<AccountTransferUpdate[]> {
  try {
    const res = await client.get("/v1/accountTransferUpdates", {
      params: {
        address,
        accountIndex,
        limit: options.limit ?? 100,
        // `from` filters on createdAt in epoch MICROSECONDS; anything at
        // millisecond scale is rejected with a 400 rather than coerced.
        ...(options.from !== undefined ? { from: options.from.toString() } : {}),
      },
    });
    if (res.status === 404) return [];
    const body = expectOk("getAccountTransferUpdates", res.status, res.data);
    return Array.isArray(body)
      ? body
      : ((body as { transfers?: AccountTransferUpdate[] }).transfers ?? []);
  } catch (error) {
    return fail("getAccountTransferUpdates", error);
  }
}

// ---------------------------------------------------------------------------
// Signed writes.
// ---------------------------------------------------------------------------

function sideToWire(side: PlaceOrderParams["side"]): number {
  return side === "BUY" ? OrderSignSide.Buy : OrderSignSide.Sell;
}

/// goodTilTime is mandatory on every order -- including IOC and FOK, which never
/// rest -- and must be at least one month ahead when the gateway processes it.
/// Returned in epoch microseconds, the unit the request body wants.
export function goodTilTimeMicros(now: number = Date.now()): bigint {
  const future = now + config.arcusGoodTilDays * 24 * 60 * 60 * 1000;
  return BigInt(future) * 1000n;
}

export async function placeOrder(
  credentials: ArcusCredentials,
  params: PlaceOrderParams,
): Promise<PlaceOrderResult> {
  const timestamp = unixNanos();
  const goodTilMicros = goodTilTimeMicros();

  // The signed payload carries engine-native integers, so the exchange grid is
  // applied here. An inexact division throws rather than rounding: a rounded
  // tick would sign a price the caller never asked for.
  const ticks = divideExact(params.price, params.tickSize);
  const quantums = divideExact(params.quantity, params.stepSize);

  const payload: PlaceOrderSignPayload = {
    ad: credentials.address.toLowerCase(),
    ai: credentials.accountIndex,
    ...(params.clientId ? { c: params.clientId } : {}),
    ct: timestamp,
    // `g` is the microsecond goodTilTime x 1000.
    g: goodTilMicros * 1000n,
    m: params.marketId,
    op: OrderSignOp.Place,
    p: ticks,
    q: quantums,
    r: params.reduceOnly ? 1 : 0,
    s: sideToWire(params.side),
    t: OrderSignTif[params.timeInForce],
    v: 1,
  };

  const signed = signArcusRequest({
    scheme: "typed",
    apiKey: credentials.apiKey,
    secret: credentials.secret,
    payload,
  });

  const body = {
    address: credentials.address,
    accountIndex: credentials.accountIndex,
    marketId: params.marketId,
    orderSide: params.side,
    orderType: params.orderType,
    timeInForce: params.timeInForce,
    quantity: params.quantity,
    price: params.price,
    goodTilTime: goodTilMicros.toString(),
    reduceOnly: params.reduceOnly ?? false,
    ...(params.clientId ? { clientId: params.clientId } : {}),
    clientTime: signed.timestamp,
    timestamp: Number(signed.timestamp),
  };

  try {
    const res = await client.post("/v1/placeOrder", body, {
      params: { address: credentials.address },
      headers: signedHeaders(signed),
    });
    const result = expectOk("placeOrder", res.status, res.data) as PlaceOrderResult;
    log.info("order accepted", {
      orderId: result.orderId,
      clientId: params.clientId,
      status: result.status,
      accountIndex: credentials.accountIndex,
      httpStatus: res.status,
    });
    // 202 + ACK is the common case; it is not settlement. The fill arrives on
    // the userFills stream, which must already be subscribed.
    return result;
  } catch (error) {
    return fail("placeOrder", error);
  }
}

export async function setLeverage(
  credentials: ArcusCredentials,
  params: { marketId: number; leverage: number; isolated: boolean },
): Promise<void> {
  const body = {
    address: credentials.address,
    accountIndex: credentials.accountIndex,
    marketId: params.marketId,
    leverage: params.leverage,
    isolated: params.isolated,
  };

  const signed = signArcusRequest({
    scheme: "legacy",
    apiKey: credentials.apiKey,
    secret: credentials.secret,
    action: "setLeverage",
    body,
  });

  try {
    const res = await client.post("/v1/setLeverage", body, {
      params: { address: credentials.address },
      headers: signedHeaders(signed),
    });
    expectOk("setLeverage", res.status, res.data);
  } catch (error) {
    return fail("setLeverage", error);
  }
}

/// Positive `amount` adds margin to the isolated leg, negative removes it.
/// Dollars as a decimal string -- never quote quantums; the gateway converts.
export async function adjustIsolatedMargin(
  credentials: ArcusCredentials,
  params: { marketId: number; amount: string },
): Promise<AdjustIsolatedMarginResult> {
  const body = {
    address: credentials.address,
    accountIndex: credentials.accountIndex,
    marketId: params.marketId,
    amount: params.amount,
  };

  const signed = signArcusRequest({
    scheme: "legacy",
    apiKey: credentials.apiKey,
    secret: credentials.secret,
    action: "adjustIsolatedMargin",
    body,
  });

  try {
    const res = await client.post("/v1/adjustIsolatedMargin", body, {
      params: { address: credentials.address, accountIndex: credentials.accountIndex },
      headers: signedHeaders(signed),
    });
    const result = expectOk(
      "adjustIsolatedMargin",
      res.status,
      res.data,
    ) as AdjustIsolatedMarginResult;
    if (result.status && result.status !== "APPLIED" && result.status !== "ACK") {
      throw new ArcusError(
        `adjustIsolatedMargin rejected: ${result.rejectReason ?? result.status}`,
        res.status,
        result,
      );
    }
    return result;
  } catch (error) {
    return fail("adjustIsolatedMargin", error);
  }
}

export async function cancelAllOrders(
  credentials: ArcusCredentials,
  params: { marketId?: number } = {},
): Promise<void> {
  const body = {
    address: credentials.address,
    accountIndex: credentials.accountIndex,
    ...(params.marketId !== undefined ? { marketId: params.marketId } : {}),
  };

  const signed = signArcusRequest({
    scheme: "legacy",
    apiKey: credentials.apiKey,
    secret: credentials.secret,
    action: "cancelAllOrders",
    body,
  });

  try {
    const res = await client.post("/v1/cancelAllOrders", body, {
      params: { address: credentials.address },
      headers: signedHeaders(signed),
    });
    expectOk("cancelAllOrders", res.status, res.data);
  } catch (error) {
    return fail("cancelAllOrders", error);
  }
}

/**
 * Move collateral between two subaccounts of the same wallet.
 *
 * Unlike every other write here this is not Ed25519-signed: the gateway
 * authenticates it from a secp256k1 EIP-712 signature in the body, so the
 * caller supplies `signature` from the operator wallet's EVM key. Used to sweep
 * a closed position's leftover collateral back to index 0 before recycling the
 * slot.
 */
export async function submitInternalTransfer(params: {
  ethereumAddress: string;
  fromAccountIndex: number;
  toAccountIndex: number;
  /// Integer quote quantums, as a decimal string (1e9 = $1).
  amount: string;
  nonce: string;
  signature: { r: string; s: string; v: string };
}): Promise<{ transferId?: string; status?: string }> {
  try {
    const res = await client.post("/v1/transfer", params);
    return expectOk("submitInternalTransfer", res.status, res.data) as {
      transferId?: string;
      status?: string;
    };
  } catch (error) {
    return fail("submitInternalTransfer", error);
  }
}
