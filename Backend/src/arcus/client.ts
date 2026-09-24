import axios, { AxiosError, type AxiosInstance } from "axios";

import { config } from "../config/env";
import { divideExact } from "../lib/decimal";
import { ArcusError } from "../lib/errors";
import { sleep } from "../lib/async";
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
  ArcusMarketMeta,
  ArcusOrderStatus,
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
// Heavyweight writes. setLeverage, withdraw and transfer each cost 125 of the
// per-IP 1,500/minute weight budget -- about 12 a minute, shared by every slot.
// They go through one queue, spaced out, and a 429 waits out Retry-After (or
// the body's retryAfterMs) before the same call is sent again. Only a 429 is
// retried: the request was rejected before the handler ran, so it moved nothing.
// ---------------------------------------------------------------------------

const HEAVY_SPACING_MS = 5_000;
const HEAVY_MAX_429_RETRIES = 5;
let heavyTail: Promise<unknown> = Promise.resolve();
let lastHeavyAt = 0;

function retryAfterMs(res: { headers: Record<string, unknown>; data: unknown }): number {
  const body = res.data as { retryAfterMs?: number } | undefined;
  if (body && typeof body.retryAfterMs === "number") return body.retryAfterMs;
  const header = Number(res.headers["retry-after"]);
  return Number.isFinite(header) && header > 0 ? header * 1000 : HEAVY_SPACING_MS;
}

type HttpResult = { status: number; data: unknown; headers: Record<string, unknown> };

export function heavyWrite(action: string, send: () => Promise<HttpResult>): Promise<HttpResult> {
  const run = heavyTail.catch(() => undefined).then(async () => {
    for (let attempt = 0; ; attempt += 1) {
      const wait = lastHeavyAt + HEAVY_SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastHeavyAt = Date.now();
      const res = await send();
      if (res.status !== 429 || attempt >= HEAVY_MAX_429_RETRIES) return res;
      const delay = retryAfterMs(res);
      log.warn("heavyweight write rate limited; backing off", { action, delay });
      await sleep(delay);
    }
  });
  heavyTail = run;
  return run;
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

/// Market metadata (name, logo) from `GET /v1/api-meta/markets`. With a
/// ticker, that one record or null (a 404 means Arcus has no metadata for it);
/// without, the whole list.
export async function getMarketMeta(ticker?: string): Promise<ArcusMarketMeta[]> {
  try {
    const res = await client.get("/v1/api-meta/markets", { params: ticker ? { market: ticker } : undefined });
    if (res.status === 404) return [];
    const body = expectOk("getMarketMeta", res.status, res.data);
    return (body as { results?: ArcusMarketMeta[] }).results ?? [];
  } catch (error) {
    return fail("getMarketMeta", error);
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

/// One order's current state -- the REST fallback for an order the stream has
/// not settled yet. Null on 404 (not indexed yet).
export async function getOrderStatus(
  address: string,
  accountIndex: number,
  orderId: string,
): Promise<ArcusOrderStatus | null> {
  try {
    const res = await client.get(`/v1/order/${encodeURIComponent(orderId)}`, { params: { address, accountIndex } });
    if (res.status === 404) return null;
    return expectOk("getOrderStatus", res.status, res.data) as ArcusOrderStatus;
  } catch (error) {
    return fail("getOrderStatus", error);
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

  try {
    // Signed inside the send, not up front: a queued wait longer than the
    // timestamp drift window would otherwise stale the signature.
    const res = await heavyWrite("setLeverage", () => {
      const fresh = signArcusRequest({
        scheme: "legacy",
        apiKey: credentials.apiKey,
        secret: credentials.secret,
        action: "setLeverage",
        body,
      });
      return client.post("/v1/setLeverage", body, {
        params: { address: credentials.address },
        headers: signedHeaders(fresh),
      });
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
 * slot. Weight 125 -- goes through the heavyweight queue.
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
    const res = await heavyWrite("transfer", () => client.post("/v1/transfer", params));
    return expectOk("submitInternalTransfer", res.status, res.data) as {
      transferId?: string;
      status?: string;
    };
  } catch (error) {
    return fail("submitInternalTransfer", error);
  }
}

export interface WithdrawalSubmitted {
  /// Absent only when Arcus answered 409 (this nonce was already accepted) and
  /// the body did not echo the id -- the caller then finds it on the feed.
  withdrawalId?: string;
  status: string;
  /// True on a 409: an earlier submit with this nonce already went through.
  duplicate: boolean;
}

/**
 * Withdraw USDG collateral from a subaccount back on-chain. Withdraw-to-self:
 * the funds always arrive at `ethereumAddress` (the slot's internal wallet).
 *
 * Two authentication modes (see ARCUS_WITHDRAW_SIGNING):
 *   - `signature`: EIP-712 `Withdraw` from the wallet's EVM key, in the body.
 *   - `credentials`: Ed25519 over the WithdrawV1 typed payload in the headers.
 *     The key needs the `withdraw` permission, or Arcus answers 403.
 *
 * Asynchronous: a 202 means queued as PENDING. The outcome arrives as a
 * WITHDRAWAL on the transfer feed, correlated on `withdrawalId`. A 409 means
 * this nonce was already accepted -- a retry of a submit that went through --
 * and is treated as success.
 */
export async function submitWithdrawal(params: {
  ethereumAddress: string;
  accountIndex: number;
  /// Integer quote quantums, as a decimal string (1e9 = $1; minimum $1).
  amount: string;
  nonce: string;
  signature?: { r: string; s: string; v: string };
  credentials?: ArcusCredentials;
}): Promise<WithdrawalSubmitted> {
  const { credentials, ...rest } = params;
  const body = {
    ethereumAddress: rest.ethereumAddress,
    accountIndex: rest.accountIndex,
    amount: rest.amount,
    nonce: rest.nonce,
    ...(rest.signature ? { signature: rest.signature } : {}),
  };
  if (!credentials && !rest.signature) throw new Error("submitWithdrawal needs a signature or API-key credentials");

  try {
    const res = await heavyWrite("withdraw", () => {
      if (!credentials) return client.post("/v1/withdraw", body);
      // Signed at send time so a queued wait never stales X-Timestamp.
      const ct = unixNanos();
      const signed = signArcusRequest({
        scheme: "typed",
        apiKey: credentials.apiKey,
        secret: credentials.secret,
        payload: {
          ad: rest.ethereumAddress.toLowerCase(),
          ai: rest.accountIndex,
          ct,
          n: rest.nonce,
          op: OrderSignOp.Withdraw,
          q: BigInt(rest.amount),
          v: 1,
        },
      });
      return client.post("/v1/withdraw", body, { headers: signedHeaders(signed) });
    });

    if (res.status === 409) {
      const echoed = res.data as { withdrawalId?: string } | undefined;
      log.warn("withdraw nonce already accepted; treating as submitted", {
        accountIndex: rest.accountIndex,
        nonce: rest.nonce,
      });
      return { withdrawalId: echoed?.withdrawalId, status: "PENDING", duplicate: true };
    }
    if (res.status === 403) {
      throw new ArcusError(
        "withdraw rejected with HTTP 403 -- the slot's API key lacks the `withdraw` permission; use ARCUS_WITHDRAW_SIGNING=wallet",
        res.status,
        res.data,
      );
    }
    const result = expectOk("submitWithdrawal", res.status, res.data) as { withdrawalId: string; status: string };
    return { ...result, duplicate: false };
  } catch (error) {
    if (error instanceof ArcusError) throw error;
    return fail("submitWithdrawal", error);
  }
}
