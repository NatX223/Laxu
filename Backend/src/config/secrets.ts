/**
 * Secret resolution.
 *
 * The schema stores `evm_signer_ref` and `arcus_api_secret_ref` -- names, not
 * secrets. This module is the one place that turns a name into key material, so
 * swapping the env-backed store for a real KMS is a change to `resolveSecret`
 * and nothing else.
 *
 * Env backing: a ref `OPERATOR_A_SLOT_3` reads `SECRET_OPERATOR_A_SLOT_3`.
 */

const PREFIX = "SECRET_";

const cache = new Map<string, string>();

function envName(ref: string): string {
  return PREFIX + ref.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function resolveSecret(ref: string): string {
  const cached = cache.get(ref);
  if (cached) return cached;

  const name = envName(ref);
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Secret "${ref}" is not available. Set ${name} (see .env.example) or point resolveSecret at your KMS.`,
    );
  }

  cache.set(ref, value);
  return value;
}

/// True when the ref resolves, without throwing -- for startup health checks
/// that want to report every missing secret at once rather than the first.
export function hasSecret(ref: string): boolean {
  try {
    resolveSecret(ref);
    return true;
  } catch {
    return false;
  }
}

export function clearSecretCache(): void {
  cache.clear();
}
