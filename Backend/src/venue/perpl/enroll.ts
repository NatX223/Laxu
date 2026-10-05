import axios from "axios";
import { hashTypedData, hexToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { config } from "../../config/env";
import { ed25519SignRaw, generateEd25519KeyPair, privateKeySeedHex, publicKeyHex } from "../../lib/ed25519";
import { PERPL_SCOPE_READ_TRADE, perplApiUrl, perplChainId } from "./config";
import { PerplApiError } from "./rest";

/**
 * Programmatic API-key enrollment (integrations.md), for slots:provision:
 *
 *   1. generate an Ed25519 key pair locally;
 *   2. POST /v1/api-key/payload {chain_id, address, public_key (0x-hex),
 *      scope_mask: 3, label} with `Origin: PERPL_ORIGIN` (must be whitelisted
 *      by Perpl) -> {typed_data, mac};
 *   3. sign typed_data with the wallet (EIP-712, without the EIP712Domain
 *      type entry), and sign its EIP-712 digest with the new Ed25519 key
 *      (proof of possession);
 *   4. POST /v1/api-key/enroll -> api_key.api_key, the X-API-Key token.
 *
 * 409 (public key already registered) retries with a fresh pair; 423 (16 keys
 * per profile) is fatal. The secret is returned to the caller to print -- it
 * is never written anywhere by this module.
 */

interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface EnrolledKey {
  apiKey: string;
  /// 64-hex Ed25519 seed -- what goes in SECRET_SLOT_<n>_API.
  secretHex: string;
  publicKeyHex: string;
}

const MAX_409_RETRIES = 3;

export async function enrollApiKey(params: { evmPrivateKey: string; label: string }): Promise<EnrolledKey> {
  if (!config.perplOrigin) throw new Error("PERPL_ORIGIN is not set; programmatic enrollment needs a whitelisted Origin");
  const keyHex = (params.evmPrivateKey.startsWith("0x") ? params.evmPrivateKey : `0x${params.evmPrivateKey}`) as Hex;
  const wallet = privateKeyToAccount(keyHex);
  const http = axios.create({
    baseURL: perplApiUrl(),
    timeout: config.perplRequestTimeoutMs,
    headers: { "Content-Type": "application/json", Origin: config.perplOrigin },
    validateStatus: () => true,
  });

  for (let attempt = 0; ; attempt += 1) {
    const key = generateEd25519KeyPair();
    const publicKey = `0x${publicKeyHex(key)}`;

    const payload = await http.post("/v1/api-key/payload", {
      chain_id: perplChainId(),
      address: wallet.address,
      public_key: publicKey,
      scope_mask: PERPL_SCOPE_READ_TRADE,
      label: params.label,
    });
    if (payload.status >= 400) {
      throw new PerplApiError(`api-key payload rejected with HTTP ${payload.status}`, payload.status, payload.data);
    }
    const { typed_data: typedData, mac } = payload.data as { typed_data: TypedData; mac: string };

    // Sign exactly what was returned, minus the domain type entry.
    const { EIP712Domain: _domainType, ...types } = typedData.types;
    const typed = {
      domain: typedData.domain,
      types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    } as never;
    const signature = await wallet.signTypedData(typed);
    const digest = hashTypedData(typed);
    const popSignature = `0x${ed25519SignRaw(key, hexToBytes(digest)).toString("hex")}`;

    const enroll = await http.post("/v1/api-key/enroll", {
      chain_id: perplChainId(),
      address: wallet.address,
      typed_data: typedData,
      mac,
      signature,
      pop_signature: popSignature,
    });
    if (enroll.status === 409 && attempt < MAX_409_RETRIES) continue;
    if (enroll.status === 423) {
      throw new PerplApiError("Perpl key limit reached for this wallet (16 active keys); revoke one at /apikeys", 423, enroll.data);
    }
    if (enroll.status >= 400) {
      throw new PerplApiError(`api-key enroll rejected with HTTP ${enroll.status}`, enroll.status, enroll.data);
    }
    const apiKey = (enroll.data as { api_key?: { api_key?: string } }).api_key?.api_key;
    if (!apiKey) throw new PerplApiError("api-key enroll answered without an api_key", enroll.status, enroll.data);
    return { apiKey, secretHex: privateKeySeedHex(key), publicKeyHex: publicKey };
  }
}
