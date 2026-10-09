/**
 * Perpl builder code (integrations.md, "Builder codes"). Perpl registers a
 * builder id (1..255); each slot key is enrolled bound to it with a fee
 * ceiling (scripts/perpl/enrollSlotKey.ts --builder-id --max-fee); each order
 * may then carry `bf`, the fee in hundred-thousandths (1 = 0.1 bps = 0.001%),
 * at most the key's ceiling.
 *
 *   - Omitting `bf` on a builder-bound key: the order is attributed to the code
 *     at zero fee. So a fee of 0 sends no `bf` at all.
 *   - Any `bf` on a key with no builder binding, or above the ceiling, is
 *     rejected with 400 "builder fee not permitted for this api key". So `bf`
 *     is never sent while the flag is off.
 *
 * Off by default; charging a fee is a product decision.
 */

export interface BuilderConfig {
  enabled: boolean;
  /// 1..255 when enabled.
  builderId: number | null;
  /// The ceiling the keys were enrolled with, per 100k (<= 100).
  maxFeePer100k: number;
  /// The fee charged per order, per 100k (<= maxFeePer100k).
  feePer100k: number;
}

/// Perpl's maximum enrolled ceiling: 100 per 100k = 0.1%.
export const MAX_BUILDER_FEE_PER_100K = 100;

function wholeNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be a whole number, got "${raw}"`);
  return Number(raw.trim());
}

/**
 * Parse and validate the four env vars. Throws (refusing to boot) only on a
 * value that is malformed, or inconsistent while the flag is on.
 */
export function builderConfigFrom(env: Record<string, string | undefined>): BuilderConfig {
  const enabled = (env.PERPL_BUILDER_ENABLED ?? "").toLowerCase() === "true" || env.PERPL_BUILDER_ENABLED === "1";
  const id = env.PERPL_BUILDER_ID?.trim() ? wholeNumber("PERPL_BUILDER_ID", env.PERPL_BUILDER_ID, 0) : null;
  const maxFeePer100k = wholeNumber("PERPL_MAX_BUILDER_FEE_PER_100K", env.PERPL_MAX_BUILDER_FEE_PER_100K, 0);
  const feePer100k = wholeNumber("PERPL_BUILDER_FEE_PER_100K", env.PERPL_BUILDER_FEE_PER_100K, 0);

  if (enabled) {
    if (id === null || id < 1 || id > 255) throw new Error("PERPL_BUILDER_ENABLED=true needs PERPL_BUILDER_ID in 1..255");
    if (maxFeePer100k > MAX_BUILDER_FEE_PER_100K) {
      throw new Error(`PERPL_MAX_BUILDER_FEE_PER_100K is at most ${MAX_BUILDER_FEE_PER_100K} (0.1%), got ${maxFeePer100k}`);
    }
    if (feePer100k > maxFeePer100k) {
      throw new Error(
        `PERPL_BUILDER_FEE_PER_100K (${feePer100k}) is above the enrolled ceiling PERPL_MAX_BUILDER_FEE_PER_100K (${maxFeePer100k}); Perpl would reject every order`,
      );
    }
  }
  return { enabled, builderId: id, maxFeePer100k, feePer100k };
}

/// The fee actually charged, per 100k: 0 unless enabled.
export function chargedFeePer100k(builder: BuilderConfig): number {
  return builder.enabled ? builder.feePer100k : 0;
}

/// What to spread into an order that changes a position's size: `{ bf }` only
/// when enabled with a fee above 0, else nothing at all.
export function builderFeeField(builder: BuilderConfig): { bf?: number } {
  const fee = chargedFeePer100k(builder);
  return fee > 0 ? { bf: Math.min(fee, builder.maxFeePer100k) } : {};
}

/// Percent of notional: 1 per 100k = 0.001%.
export function per100kToPct(per100k: number): number {
  return per100k / 1000;
}
