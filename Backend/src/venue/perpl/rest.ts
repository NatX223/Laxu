import axios, { AxiosError, type AxiosInstance } from "axios";

import { config } from "../../config/env";
import { sleep } from "../../lib/async";
import { loadEd25519PrivateKey } from "../../lib/ed25519";
import { createLogger } from "../../lib/logger";
import { perplApiUrl, perplChainId } from "./config";
import { recordRest } from "./recorder";
import { signedHeaders } from "./signing";
import type {
  ApiAccountEvent,
  ApiContext,
  ApiFill,
  ApiOrder,
  ApiPosition,
  ApiTicker,
  ApiWallet,
  BatchStatusResponse,
  HistoryPage,
  OrderSpec,
  PerplCredentials,
} from "./types";

const log = createLogger("perpl:rest");

/// A non-2xx answer from Perpl, with enough of the response to decide what to do.
export class PerplApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "PerplApiError";
  }
}

let client: AxiosInstance | undefined;

function http(): AxiosInstance {
  client ??= axios.create({
    baseURL: perplApiUrl(),
    timeout: config.perplRequestTimeoutMs,
    // Everything below 500 comes back to the caller for inspection.
    validateStatus: (status) => status < 500,
    // Keep the body exactly as sent: the signature covers its sha256.
    transformRequest: [(data) => data],
  });
  return client;
}

/// 429 (and 503 "not available yet") back off 1s, 2s, 4s before giving up.
const BACKOFF_MS = [1_000, 2_000, 4_000];

async function request<T>(
  label: string,
  method: "GET" | "POST",
  target: string,
  body: string,
  headers: () => Record<string, string>,
  wallet?: string,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    let status: number;
    let data: unknown;
    try {
      const res = await http().request({
        method,
        url: target,
        data: body === "" ? undefined : body,
        // Fresh timestamp + nonce on every attempt -- a nonce is single-use.
        headers: { ...(body === "" ? {} : { "Content-Type": "application/json" }), ...headers() },
      });
      status = res.status;
      data = res.data;
      recordRest({ method, target, status, body: data, requestBody: body === "" ? undefined : safeJson(body), wallet });
    } catch (error) {
      recordRest({
        method,
        target,
        status: error instanceof AxiosError ? (error.response?.status ?? null) : null,
        body: error instanceof AxiosError ? error.response?.data : undefined,
        requestBody: body === "" ? undefined : safeJson(body),
        wallet,
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof AxiosError && error.response?.status === 503 && attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      throw new PerplApiError(
        `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof AxiosError ? error.response?.status : undefined,
        error instanceof AxiosError ? error.response?.data : undefined,
      );
    }
    if (status === 429 && attempt < BACKOFF_MS.length) {
      log.warn("rate limited; backing off", { label, delayMs: BACKOFF_MS[attempt] });
      await sleep(BACKOFF_MS[attempt]);
      continue;
    }
    if (status >= 400) throw new PerplApiError(`${label} rejected with HTTP ${status}`, status, data);
    return data as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/// Unauthenticated GET. `target` starts at /v1/.
export function publicGet<T>(target: string): Promise<T> {
  return request<T>(`GET ${target}`, "GET", target, "", () => ({}));
}

/// A request signed with the slot's API key (the four X-API-* headers).
export function signedRequest<T>(
  credentials: PerplCredentials,
  method: "GET" | "POST",
  target: string,
  body?: unknown,
): Promise<T> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const key = loadEd25519PrivateKey(credentials.apiSecret);
  return request<T>(
    `${method} ${target}`,
    method,
    target,
    raw,
    () => signedHeaders({ key, apiKey: credentials.apiKey, chainId: perplChainId(), method, target, body: raw }),
    credentials.address,
  );
}

// --- Public market data ------------------------------------------------------------

export function getContext(): Promise<ApiContext> {
  return publicGet<ApiContext>("/v1/pub/context");
}

/// One market's state, keyed by market id (a map with one entry).
export function getTicker(marketId: number): Promise<ApiTicker> {
  return publicGet<ApiTicker>(`/v1/market-data/${marketId}/ticker`);
}

export function getAllTickers(): Promise<ApiTicker> {
  return publicGet<ApiTicker>("/v1/market-data/ticker");
}

export function getBook(marketId: number, levels = 20): Promise<{ sn: number; bid: Array<{ p: number; s: number; o: number }>; ask: Array<{ p: number; s: number; o: number }> }> {
  return publicGet(`/v1/market-data/${marketId}/book?levels=${levels}`);
}

// --- Trading state (signed, any scope) ------------------------------------------------

/// The wallet snapshot: its accounts (with `fw` and `lfr`) and `sn`, the block
/// the snapshot is current as of. 404 = the wallet holds no exchange account.
export function getWallet(credentials: PerplCredentials): Promise<ApiWallet> {
  return signedRequest<ApiWallet>(credentials, "GET", "/v1/trading/wallet");
}

export function getPositions(credentials: PerplCredentials): Promise<{ sn?: number; d: ApiPosition[] }> {
  return signedRequest(credentials, "GET", "/v1/trading/positions");
}

export function getOpenOrders(credentials: PerplCredentials): Promise<{ sn?: number; d: ApiOrder[] }> {
  return signedRequest(credentials, "GET", "/v1/trading/orders");
}

/// Order submission over HTTP -- one order is a batch of one. A zero code is
/// "accepted for forwarding", not an outcome.
export function postOrders(credentials: PerplCredentials, orders: OrderSpec[]): Promise<BatchStatusResponse> {
  return signedRequest<BatchStatusResponse>(credentials, "POST", "/v1/trading/orders", { d: orders });
}

// --- History (signed, paginated newest -> oldest) ----------------------------------------

function historyTarget(path: string, page?: string, count = 100): string {
  const params = new URLSearchParams({ count: String(count) });
  if (page) params.set("page", page);
  return `${path}?${params.toString()}`;
}

export function getOrderHistory(credentials: PerplCredentials, page?: string, count = 100): Promise<HistoryPage<ApiOrder>> {
  return signedRequest(credentials, "GET", historyTarget("/v1/trading/order-history", page, count));
}

export function getFills(credentials: PerplCredentials, page?: string, count = 100): Promise<HistoryPage<ApiFill>> {
  return signedRequest(credentials, "GET", historyTarget("/v1/trading/fills", page, count));
}

export function getAccountHistory(
  credentials: PerplCredentials,
  page?: string,
  count = 100,
): Promise<HistoryPage<ApiAccountEvent>> {
  return signedRequest(credentials, "GET", historyTarget("/v1/trading/account-history", page, count));
}

export function getPositionHistory(
  credentials: PerplCredentials,
  page?: string,
  count = 100,
): Promise<HistoryPage<ApiPosition>> {
  return signedRequest(credentials, "GET", historyTarget("/v1/trading/position-history", page, count));
}

/**
 * Walk a history endpoint newest -> oldest until `stop` says so or `maxPages`
 * is reached. `stop` sees each page; return true to end the walk.
 */
export async function walkHistory<T>(
  fetchPage: (page?: string) => Promise<HistoryPage<T>>,
  stop: (items: T[]) => boolean,
  maxPages = 5,
): Promise<T[]> {
  const all: T[] = [];
  let page: string | undefined;
  for (let i = 0; i < maxPages; i += 1) {
    const result = await fetchPage(page);
    const items = result.d ?? [];
    all.push(...items);
    if (stop(items) || !result.np || items.length === 0) break;
    page = result.np;
  }
  return all;
}
