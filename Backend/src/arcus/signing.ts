import type { KeyObject } from "node:crypto";

import { canonicalJson } from "../lib/canonicalJson";
import { ed25519Sign, loadEd25519PrivateKey } from "./ed25519";

/**
 * The one signing utility every Arcus call routes through.
 *
 * Arcus has two schemes, and the difference is only *which bytes get signed* --
 * both produce an Ed25519 signature carried in the same three values
 * (`X-API-Key`, `X-Timestamp`, `X-Signature` over REST; `apiKey`, `timestamp`,
 * `signature` in the WebSocket envelope).
 *
 * Scheme "typed" -- placeOrder / cancelOrder / modifyOrder (and each element of
 *   their batch variants). The signed message is a compact, key-sorted JSON
 *   object of engine-native integers. It is NOT the HTTP body: prices and sizes
 *   appear as integer ticks and quantums, the timestamp lives inside as `ct`,
 *   and there is no action prefix.
 *
 * Scheme "legacy" -- everything else: setLeverage, adjustIsolatedMargin,
 *   cancelAllOrders, createApiKey, WebSocket `authenticate`. The signed message
 *   is `timestamp + action + canonicalJson(body)` concatenated with no
 *   delimiters, where `action` is the camelCase final path segment.
 */

export type ArcusSigningScheme = "typed" | "legacy";

/// Operation discriminator inside the typed payload. A distinct value per
/// operation is what stops a signature being replayed as a different one.
export const OrderSignOp = {
  Place: 1,
  Cancel: 2,
  Modify: 3,
  PlaceUntriggered: 4,
  /// WithdrawV1 (API-key-signed USDG withdrawal).
  Withdraw: 5,
} as const;

export const OrderSignSide = { Buy: 0, Sell: 1 } as const;

/// Wire values for timeInForce inside the typed payload.
export const OrderSignTif = { GTT: 0, FOK: 1, IOC: 2, ALO: 3 } as const;

/// The typed canonical payload for a placeOrder. Field names are Arcus's, kept
/// abbreviated deliberately -- these exact keys are what gets signed.
export interface PlaceOrderSignPayload {
  /// Master Ethereum address, lowercase hex. The only case-folded field.
  ad: string;
  /// Subaccount index.
  ai: number;
  /// Client id. Omitted entirely when empty; signed byte-for-byte verbatim.
  c?: string;
  /// Client timestamp, unix nanoseconds. Must equal the X-Timestamp sent.
  ct: bigint;
  /// goodTilTime in nanoseconds (the request's microsecond value x 1000).
  g: bigint;
  /// Market id.
  m: number;
  op: number;
  /// Price in integer ticks (price / tickSize, exact).
  p: bigint;
  /// Quantity in integer quantums (size / stepSize, exact).
  q: bigint;
  /// Reduce-only as an integer, not a boolean.
  r: 0 | 1;
  s: number;
  t: number;
  /// Payload version.
  v: 1;
}

export interface SignedRequest {
  apiKey: string;
  /// Unix nanoseconds, as a decimal string.
  timestamp: string;
  /// 128-char lowercase hex.
  signature: string;
  /// The exact bytes signed. Kept for debugging a rejected signature.
  message: string;
}

export interface TypedSignInput {
  scheme: "typed";
  apiKey: string;
  secret: string | KeyObject;
  payload: PlaceOrderSignPayload | Record<string, unknown>;
}

export interface LegacySignInput {
  scheme: "legacy";
  apiKey: string;
  secret: string | KeyObject;
  /// camelCase final path segment, e.g. "adjustIsolatedMargin".
  action: string;
  body?: unknown;
  /// Unix nanoseconds. Defaults to now.
  timestamp?: bigint;
}

export type SignArcusRequestInput = TypedSignInput | LegacySignInput;

export function unixNanos(now: number = Date.now()): bigint {
  return BigInt(now) * 1_000_000n;
}

function toKey(secret: string | KeyObject): KeyObject {
  return typeof secret === "string" ? loadEd25519PrivateKey(secret) : secret;
}

export function signArcusRequest(input: SignArcusRequestInput): SignedRequest {
  const key = toKey(input.secret);

  if (input.scheme === "typed") {
    const payload = input.payload as PlaceOrderSignPayload;
    if (payload.ct === undefined) {
      throw new Error("typed payload must carry `ct` (it is the X-Timestamp sent)");
    }
    // `ad` is the only field Arcus case-folds before verifying.
    const normalised = { ...payload, ad: String(payload.ad).toLowerCase() };
    const message = canonicalJson(normalised);
    return {
      apiKey: input.apiKey,
      timestamp: payload.ct.toString(),
      signature: ed25519Sign(key, message),
      message,
    };
  }

  const timestamp = input.timestamp ?? unixNanos();
  // No delimiters between the three parts -- concatenation is the format.
  const body = input.body === undefined ? "" : canonicalJson(input.body);
  const message = `${timestamp.toString()}${input.action}${body}`;
  return {
    apiKey: input.apiKey,
    timestamp: timestamp.toString(),
    signature: ed25519Sign(key, message),
    message,
  };
}

export function signedHeaders(signed: SignedRequest): Record<string, string> {
  return {
    "X-API-Key": signed.apiKey,
    "X-Timestamp": signed.timestamp,
    "X-Signature": signed.signature,
  };
}
