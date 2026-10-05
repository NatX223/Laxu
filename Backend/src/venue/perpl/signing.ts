import { createHash, randomBytes, type KeyObject } from "node:crypto";

import { ed25519SignRaw } from "../../lib/ed25519";

/**
 * Perpl request signing (authentication.md). Every REST request and the
 * trading WebSocket sign-in are signed with the API key's Ed25519 private key;
 * there is no bearer token.
 *
 * REST canonical string, six fields joined by "\n":
 *   chainId, METHOD, request-target (path + query exactly as sent, starting
 *   /v1/...), timestamp ms, nonce, sha256 hex of the raw body ("" -> sha256 of "")
 *
 * WS sign-in canonical string, four fields:
 *   chainId, "trading-ws-signin", timestamp ms, nonce
 *
 * Signature: base64url (no padding) of the raw 64-byte Ed25519 signature.
 * Nonce: 16 random bytes, base64url. Timestamps must be within 30s of server time.
 */

export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function restCanonical(params: {
  chainId: number;
  method: string;
  target: string;
  timestampMs: string;
  nonce: string;
  body: string;
}): string {
  return [
    String(params.chainId),
    params.method.toUpperCase(),
    params.target,
    params.timestampMs,
    params.nonce,
    sha256Hex(params.body),
  ].join("\n");
}

export function wsSignInCanonical(params: { chainId: number; timestampMs: string; nonce: string }): string {
  return [String(params.chainId), "trading-ws-signin", params.timestampMs, params.nonce].join("\n");
}

export function signCanonical(key: KeyObject, canonical: string): string {
  return ed25519SignRaw(key, canonical).toString("base64url");
}

/// The four X-API-* headers for one REST request.
export function signedHeaders(params: {
  key: KeyObject;
  apiKey: string;
  chainId: number;
  method: string;
  target: string;
  body: string;
  now?: number;
}): Record<string, string> {
  const timestampMs = String(params.now ?? Date.now());
  const nonce = newNonce();
  const canonical = restCanonical({
    chainId: params.chainId,
    method: params.method,
    target: params.target,
    timestampMs,
    nonce,
    body: params.body,
  });
  return {
    "X-API-Key": params.apiKey,
    "X-API-Timestamp": timestampMs,
    "X-API-Nonce": nonce,
    "X-API-Signature": signCanonical(params.key, canonical),
  };
}

/// The mt:29 ApiKeySignIn frame -- must be the first frame on the socket.
export function signInFrame(params: { key: KeyObject; apiKey: string; chainId: number; now?: number }) {
  const timestamp = String(params.now ?? Date.now());
  const nonce = newNonce();
  return {
    mt: 29,
    chain_id: params.chainId,
    api_key: params.apiKey,
    timestamp,
    nonce,
    signature: signCanonical(params.key, wsSignInCanonical({ chainId: params.chainId, timestampMs: timestamp, nonce })),
  };
}
