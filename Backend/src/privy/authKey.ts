import { createPrivateKey } from "node:crypto";

/**
 * The SDK wants the authorization private key as base64 PKCS8 DER with no PEM
 * header (an optional `wallet-auth:` prefix is stripped by the SDK). The
 * quickstart's `openssl ecparam -genkey` writes a SEC1 PEM ("EC PRIVATE KEY"),
 * which is not that, so every common shape is accepted here and normalised.
 *
 * Never log the input or the output.
 */
export function normalizeAuthKey(raw: string): string {
  const text = raw.trim().replace(/^wallet-auth:/, "").replace(/\\n/g, "\n");
  const key = text.includes("BEGIN")
    ? createPrivateKey(text)
    : (() => {
        const der = Buffer.from(text, "base64");
        try {
          return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
        } catch {
          return createPrivateKey({ key: der, format: "der", type: "sec1" });
        }
      })();
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("PRIVY_AUTH_PRIVATE_KEY must be a P-256 (prime256v1) key");
  }
  return key.export({ format: "der", type: "pkcs8" }).toString("base64");
}
