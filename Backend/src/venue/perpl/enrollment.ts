import type { KeyObject } from "node:crypto";

import axios, { type AxiosInstance } from "axios";
import { hashTypedData, hexToBytes, type Hex, type LocalAccount } from "viem";

import { ed25519SignRaw, publicKeyHex } from "../../lib/ed25519";

/**
 * Programmatic API-key enrollment (integrations.md), for scripts/perpl/enrollSlotKey.ts:
 *
 *   POST /v1/api-key/payload {chain_id, address, public_key, scope_mask, label,
 *        builder_id?, max_builder_fee_per_100k?}  -> {typed_data, mac}
 *   sign typed_data with the wallet (EIP-712), and its digest
 *        keccak256(0x1901 || domainSeparator || hashStruct(message)) with the
 *        new Ed25519 key (proof of possession)
 *   POST /v1/api-key/enroll {chain_id, address, typed_data, mac, signature,
 *        pop_signature}  -> {api_key: ApiKeyInfo}
 *
 * Both calls need an `Origin` Perpl has whitelisted, set explicitly from a
 * server. Nothing here prints or stores a secret; the caller decides where the
 * new key goes. (venue/perpl/enroll.ts is the older single-call version
 * slots:provision uses; it is left as is.)
 */

export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface PayloadRequest {
  chainId: number;
  address: string;
  /// Raw 32-byte Ed25519 public key, 0x-hex.
  publicKey: string;
  scope: 1 | 2 | 3;
  label: string;
  builderId?: number;
  maxBuilderFeePer100k?: number;
}

export interface Payload {
  typedData: TypedData;
  /// Opaque; echoed back unchanged.
  mac: string;
}

/// ApiKeyInfo. `api_key` is the secret-equivalent X-API-Key token.
export interface ApiKeyInfo {
  api_key: string;
  address: string;
  scope_mask: number;
  label: string;
  origin?: string;
  expires_at?: number;
  created_at?: number;
  builder_id?: number;
  builder_name?: string;
  max_builder_fee_per_100k?: number;
  max_builder_fee_pct?: string;
}

export type EnrollFailure = "origin" | "not-found" | "key-exists" | "key-limit" | "builder" | "rejected";

export class EnrollError extends Error {
  constructor(
    message: string,
    readonly kind: EnrollFailure,
    readonly status?: number,
    /// Perpl's own error text, as returned (never contains a secret).
    readonly detail?: string,
  ) {
    super(message);
    this.name = "EnrollError";
  }
}

function detailOf(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  if (body && typeof body === "object") {
    const b = body as { error?: unknown; message?: unknown };
    const text = typeof b.error === "string" ? b.error : typeof b.message === "string" ? b.message : JSON.stringify(body);
    return text.slice(0, 300);
  }
  return "";
}

/// The documented failures, as messages a person can act on.
export function enrollError(step: "payload" | "enroll", status: number, body: unknown): EnrollError {
  const detail = detailOf(body);
  if (step === "enroll" && status === 404) {
    return new EnrollError("Target profile not found (404).", "not-found", status, detail);
  }
  if (step === "enroll" && status === 409) {
    return new EnrollError(
      "This public key is already registered (409). A revoked key can never be re-enrolled; the script always generates a fresh key pair.",
      "key-exists",
      status,
      detail,
    );
  }
  if (step === "enroll" && status === 423) {
    return new EnrollError(
      "This wallet already has 16 active API keys (423). Keys can only be revoked in Perpl's web UI (/apikeys); revoke an old one there, then rerun.",
      "key-limit",
      status,
      detail,
    );
  }
  if (status === 400 && /builder/i.test(detail)) {
    return new EnrollError(`Perpl refused the builder terms (400): ${detail}`, "builder", status, detail);
  }
  if (status === 401 || status === 403 || /origin|cors/i.test(detail)) {
    return new EnrollError(
      `Perpl refused the request's Origin (HTTP ${status}). The origin must be whitelisted by Perpl first.`,
      "origin",
      status,
      detail,
    );
  }
  return new EnrollError(`api-key ${step} rejected with HTTP ${status}`, "rejected", status, detail);
}

export function enrollmentHttp(params: { apiUrl: string; origin: string; timeoutMs?: number }): AxiosInstance {
  if (!params.origin) throw new Error("PERPL_ENROLL_ORIGIN is not set: enrollment needs the Origin Perpl whitelisted");
  return axios.create({
    baseURL: params.apiUrl.replace(/\/$/, ""),
    timeout: params.timeoutMs ?? 15_000,
    headers: { "Content-Type": "application/json", Origin: params.origin },
    validateStatus: () => true,
  });
}

export function publicKey0x(key: KeyObject): string {
  return `0x${publicKeyHex(key)}`;
}

export async function requestPayload(http: AxiosInstance, request: PayloadRequest): Promise<Payload> {
  const body: Record<string, unknown> = {
    chain_id: request.chainId,
    address: request.address,
    public_key: request.publicKey,
    scope_mask: request.scope,
    label: request.label,
  };
  // `ip_cidrs` and `expires_at` are left unset on purpose: our hosted IP may
  // change, and slot keys do not expire.
  if (request.builderId !== undefined) {
    body.builder_id = request.builderId;
    body.max_builder_fee_per_100k = request.maxBuilderFeePer100k ?? 0;
  }
  const res = await http.post("/v1/api-key/payload", body);
  if (res.status >= 400) throw enrollError("payload", res.status, res.data);
  const data = res.data as { typed_data?: TypedData; mac?: string };
  if (!data?.typed_data || !data.mac) throw new EnrollError("api-key payload answered without typed_data/mac", "rejected", res.status);
  return { typedData: data.typed_data, mac: data.mac };
}

/// Exactly what was returned, minus the EIP712Domain type entry (viem derives it from `domain`).
function forSigning(typedData: TypedData) {
  const { EIP712Domain: _domainType, ...types } = typedData.types;
  return { domain: typedData.domain, types, primaryType: typedData.primaryType, message: typedData.message } as never;
}

/// The wallet's EIP-712 signature and the Ed25519 proof of possession over the same digest.
export async function signEnrollment(
  typedData: TypedData,
  wallet: LocalAccount,
  key: KeyObject,
): Promise<{ signature: Hex; popSignature: Hex; digest: Hex }> {
  const typed = forSigning(typedData);
  const signature = await wallet.signTypedData(typed);
  const digest = hashTypedData(typed);
  const popSignature = `0x${ed25519SignRaw(key, hexToBytes(digest)).toString("hex")}` as Hex;
  return { signature, popSignature, digest };
}

export async function submitEnroll(
  http: AxiosInstance,
  params: { chainId: number; address: string; payload: Payload; signature: Hex; popSignature: Hex },
): Promise<ApiKeyInfo> {
  const res = await http.post("/v1/api-key/enroll", {
    chain_id: params.chainId,
    address: params.address,
    typed_data: params.payload.typedData,
    mac: params.payload.mac,
    signature: params.signature,
    pop_signature: params.popSignature,
  });
  if (res.status >= 400) throw enrollError("enroll", res.status, res.data);
  const info = (res.data as { api_key?: ApiKeyInfo }).api_key;
  if (!info?.api_key) throw new EnrollError("api-key enroll answered without an api_key", "rejected", res.status);
  return info;
}

/// The human-readable part of a payload, for --dry-run: the statement and the
/// signed fields. Never the mac.
export function describePayload(typedData: TypedData): { statement: string | null; fields: Record<string, unknown>; domain: Record<string, unknown> } {
  const { statement, ...fields } = typedData.message;
  return { statement: typeof statement === "string" ? statement : null, fields, domain: typedData.domain };
}
