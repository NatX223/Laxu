import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

/**
 * Ed25519 key handling.
 *
 * Node's crypto does Ed25519 natively, so the only work here is accepting the
 * shapes an API secret arrives in:
 *
 *   - a bare 32-byte hex seed, with or without `0x` -- Perpl's "Secret" field
 *     (64 hex chars) and what most key-generation snippets hand back, and
 *   - a PKCS#8 PEM, which is what `openssl genpkey -algorithm ed25519` writes.
 *
 * A raw seed is wrapped in the fixed PKCS#8 prefix for Ed25519 so both end up
 * as the same KeyObject.
 */

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const keyCache = new Map<string, KeyObject>();

export function loadEd25519PrivateKey(secret: string): KeyObject {
  const cached = keyCache.get(secret);
  if (cached) return cached;

  const trimmed = secret.trim();
  let key: KeyObject;

  if (trimmed.includes("-----BEGIN")) {
    key = createPrivateKey({ key: trimmed, format: "pem" });
  } else {
    const hex = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("API secret must be either a PKCS#8 PEM or a 32-byte (64 hex char) Ed25519 seed");
    }
    key = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(hex, "hex")]),
      format: "der",
      type: "pkcs8",
    });
  }

  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`Expected an ed25519 key, got ${key.asymmetricKeyType ?? "unknown"}`);
  }

  keyCache.set(secret, key);
  return key;
}

/// The raw 32-byte public key, lowercase hex (no 0x).
export function publicKeyHex(privateKey: KeyObject): string {
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  // SPKI for Ed25519 is a 12-byte header followed by the 32-byte key.
  return Buffer.from(der.subarray(der.length - 32)).toString("hex");
}

/// The raw 32-byte seed, lowercase hex -- the form Perpl's docs store a secret in.
export function privateKeySeedHex(privateKey: KeyObject): string {
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  return Buffer.from(der.subarray(der.length - 32)).toString("hex");
}

/// The raw 64-byte Ed25519 signature over `message`.
export function ed25519SignRaw(privateKey: KeyObject, message: string | Buffer | Uint8Array): Buffer {
  const bytes = typeof message === "string" ? Buffer.from(message, "utf8") : Buffer.from(message);
  return sign(null, bytes, privateKey);
}

/// A fresh key pair, for programmatic API-key enrollment.
export function generateEd25519KeyPair(): KeyObject {
  return generateKeyPairSync("ed25519").privateKey;
}
