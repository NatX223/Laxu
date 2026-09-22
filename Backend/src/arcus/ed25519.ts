import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

/**
 * Ed25519 key handling.
 *
 * Node's crypto does Ed25519 natively, so the only work here is accepting the
 * two shapes an Arcus API secret arrives in:
 *
 *   - a PKCS#8 PEM, which is what `openssl genpkey -algorithm ed25519` writes
 *     (the path the Arcus docs walk through), and
 *   - a bare 32-byte hex seed, which is what most key-generation snippets and
 *     secret managers hand back.
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
    const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error(
        "Arcus API secret must be either a PKCS#8 PEM or a 32-byte (64 hex char) Ed25519 seed",
      );
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

/// The hex public key that *is* the Arcus `apiKey`. Derived from the private key
/// so a misconfigured slot (key and secret from different pairs) is caught at
/// startup rather than by a 401 on the first order.
export function publicKeyHex(privateKey: KeyObject): string {
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  // SPKI for Ed25519 is a 12-byte header followed by the 32-byte key.
  return Buffer.from(der.subarray(der.length - 32)).toString("hex");
}

/// 128-char lowercase hex signature, the only form Arcus accepts.
export function ed25519Sign(privateKey: KeyObject, message: string | Buffer): string {
  const bytes = typeof message === "string" ? Buffer.from(message, "utf8") : message;
  return sign(null, bytes, privateKey).toString("hex");
}
