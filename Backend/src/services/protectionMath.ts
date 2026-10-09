import { toBaseUnits } from "../lib/decimal";

/**
 * Loan protection arithmetic (Spec 05 Part 2.5). Pure bigint maths, no I/O.
 *
 * LendingPool.healthFactor(user) = collateralValue * thresholdBps * 1e18 / (10_000 * debt)
 * (1e18 = the liquidation line; type(uint256).max when there is no debt). To reach a target
 * health the debt must fall to D' = collateralValue * thresholdBps * 1e18 / (10_000 * target).
 */

export const WAD = 10n ** 18n;
export const BPS = 10_000n;
export const UINT256_MAX = 2n ** 256n - 1n;

/// Slack on the amount needed, for interest accruing between reading the debt and the repay mining.
export const REPAY_BUFFER_BPS = 100n; // 1%

/// Below this (debt-asset base units, 0.01 AUSD at 6 decimals) a repay is not worth its gas.
export const DUST_FLOOR = 10_000n;

export type Limit = "maxPerCall" | "remainingSpend" | "balance" | "allowance";

export interface RepayInput {
  debt: bigint;
  collateralValue: bigint;
  thresholdBps: bigint;
  /// Target health, 1e18-scaled.
  targetHealth: bigint;
  maxPerCall: bigint;
  /// maxSpend - spent, floored at 0.
  remainingSpend: bigint;
  balance: bigint;
  allowance: bigint;
  dustFloor?: bigint;
  bufferBps?: bigint;
}

export type RepayReason = "ok" | "no-debt" | "already-at-target" | "dust" | `limit:${Limit}`;

export interface RepayPlan {
  /// What reaching the target needs, buffer included, never more than the debt.
  needed: bigint;
  /// What to actually send: `needed` clamped by every limit; 0 when nothing worth sending.
  amount: bigint;
  /// The limit that cut `needed` down (when one did).
  limitedBy: Limit | null;
  reason: RepayReason;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/// The debt that puts health exactly at `targetHealth` (rounded down, so repaying `debt - D'` lands at or above it).
export function debtAtHealth(collateralValue: bigint, thresholdBps: bigint, targetHealth: bigint): bigint {
  if (targetHealth <= 0n) throw new Error("targetHealth must be positive");
  return (collateralValue * thresholdBps * WAD) / (BPS * targetHealth);
}

export function planRepay(input: RepayInput): RepayPlan {
  const dust = input.dustFloor ?? DUST_FLOOR;
  const buffer = input.bufferBps ?? REPAY_BUFFER_BPS;

  if (input.debt <= 0n) return { needed: 0n, amount: 0n, limitedBy: null, reason: "no-debt" };

  const target = debtAtHealth(input.collateralValue, input.thresholdBps, input.targetHealth);
  const base = input.debt > target ? input.debt - target : 0n;
  if (base === 0n) return { needed: 0n, amount: 0n, limitedBy: null, reason: "already-at-target" };

  const needed = min(base + ceilDiv(base * buffer, BPS), input.debt);

  // In this order, so a tie names the limit the user can do most about first.
  const limits: Array<[Limit, bigint]> = [
    ["maxPerCall", input.maxPerCall],
    ["remainingSpend", input.remainingSpend],
    ["balance", input.balance],
    ["allowance", input.allowance],
  ];
  let amount = needed;
  let limitedBy: Limit | null = null;
  for (const [name, value] of limits) {
    const bounded = value < 0n ? 0n : value;
    if (bounded < amount) {
      amount = bounded;
      limitedBy = name;
    }
  }

  if (amount < dust) {
    return { needed, amount: 0n, limitedBy, reason: limitedBy ? `limit:${limitedBy}` : "dust" };
  }
  return { needed, amount, limitedBy, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Health factor <-> decimal strings. Rules store "1.15"; chain values are 1e18-scaled.
// ---------------------------------------------------------------------------

const HEALTH_PLACES = 4;

/// "1.15" -> 1.15e18. Throws on anything that is not a plain non-negative decimal.
export function healthToWad(value: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) throw new Error(`Not a health factor: ${value}`);
  return toBaseUnits(value.trim(), 18);
}

/// 1.15e18 -> "1.1500" (truncated to 4 places). No debt (uint256 max) -> null.
export function formatHealth(wad: bigint): string | null {
  if (wad >= UINT256_MAX / 2n) return null;
  const scale = 10n ** BigInt(18 - HEALTH_PLACES);
  const units = wad / scale;
  const whole = units / 10n ** BigInt(HEALTH_PLACES);
  const frac = (units % 10n ** BigInt(HEALTH_PLACES)).toString().padStart(HEALTH_PLACES, "0");
  return `${whole}.${frac}`;
}
