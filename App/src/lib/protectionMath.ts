/**
 * The "this would repay about X now" preview for the Protect-this-loan form (Spec 05b 3.4).
 *
 * A mirror of `planRepay` in Backend/src/services/protectionMath.ts, kept dependency-free so a script can load
 * it directly (App/scripts/checkProtectionMath.mjs runs the same vectors through both and compares). The
 * backend decides at the time; this only shows what it would do. bigint throughout.
 *
 *   health = collateralValue * thresholdBps * 1e18 / (10_000 * debt)
 *   D'     = collateralValue * thresholdBps * 1e18 / (10_000 * targetHealth)     the debt that sits on the target
 *   needed = debt - D', plus a 1% buffer, never more than the debt
 *   amount = needed clamped by the per-call cap, the remaining spend, the wallet balance and the allowance;
 *            below the dust floor nothing is sent.
 */

const WAD = BigInt("1000000000000000000");
const BPS = BigInt(10000);
const ZERO = BigInt(0);
const ONE = BigInt(1);
/** REPAY_BUFFER_BPS and DUST_FLOOR in the backend. */
const BUFFER_BPS = BigInt(100);
const DUST_FLOOR = BigInt(10000);

export type Limit = "maxPerCall" | "remainingSpend" | "balance" | "allowance";
export type RepayReason = "ok" | "no-debt" | "already-at-target" | "dust" | `limit:${Limit}`;

export type RepayPreview = {
  needed: bigint;
  amount: bigint;
  limitedBy: Limit | null;
  reason: RepayReason;
};

export type PreviewInput = {
  debt: bigint;
  collateralValue: bigint;
  thresholdBps: bigint;
  /** A decimal like "1.30". */
  targetHealth: string;
  maxPerCall: bigint;
  maxSpend: bigint;
  spent: bigint;
  walletBalance: bigint;
  allowance: bigint;
};

/** "1.30" -> 1.30e18. */
export function healthToWad(value: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) throw new Error(`Not a health factor: ${value}`);
  const [whole, frac = ""] = value.trim().split(".");
  return BigInt(whole) * WAD + BigInt((frac + "0".repeat(18)).slice(0, 18));
}

export function previewRepay(input: PreviewInput): RepayPreview {
  const { debt, collateralValue, thresholdBps } = input;
  if (debt <= ZERO) return { needed: ZERO, amount: ZERO, limitedBy: null, reason: "no-debt" };

  const targetWad = healthToWad(input.targetHealth);
  if (targetWad <= ZERO) return { needed: ZERO, amount: ZERO, limitedBy: null, reason: "already-at-target" };

  const target = (collateralValue * thresholdBps * WAD) / (BPS * targetWad);
  const base = debt > target ? debt - target : ZERO;
  if (base === ZERO) return { needed: ZERO, amount: ZERO, limitedBy: null, reason: "already-at-target" };

  let needed = base + (base * BUFFER_BPS + BPS - ONE) / BPS;
  if (needed > debt) needed = debt;

  const remaining = input.maxSpend > input.spent ? input.maxSpend - input.spent : ZERO;
  // In this order, so a tie names the same limit the backend names.
  const limits: Array<[Limit, bigint]> = [
    ["maxPerCall", input.maxPerCall],
    ["remainingSpend", remaining],
    ["balance", input.walletBalance],
    ["allowance", input.allowance],
  ];
  let amount = needed;
  let limitedBy: Limit | null = null;
  for (const [name, value] of limits) {
    const bounded = value < ZERO ? ZERO : value;
    if (bounded < amount) {
      amount = bounded;
      limitedBy = name;
    }
  }

  if (amount < DUST_FLOOR) return { needed, amount: ZERO, limitedBy, reason: limitedBy ? `limit:${limitedBy}` : "dust" };
  return { needed, amount, limitedBy, reason: "ok" };
}
