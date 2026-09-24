import { PRICE_SCALE, toSize6, toUsdg6 } from "../lib/units";

/**
 * Buy-in and redeem sizing. A buy-in or redeem changes how BIG a position is,
 * never how leveraged: every share always represents the same slice of the
 * same trade. All amounts in on-chain units (lib/units.ts): USDG and size at
 * 6dp, prices at 1e18.
 */

export interface MarketGrid {
  /// Decimal strings straight from the markets table.
  stepSize: string;
  minOrderSize: string;
  minOrderNotional: string;
}

/// Round a size6 down to the market's step. A step finer than 1e-6 is already
/// satisfied by size6's own granularity.
export function floorSize6ToStep(size6: bigint, stepSize: string): bigint {
  const step6 = toSize6(stepSize);
  if (step6 <= 0n) return size6;
  return size6 - (size6 % step6);
}

/// Below the market's minimum order size or notional, an order is not placed.
export function belowMinimums(size6: bigint, mark18: bigint, grid: MarketGrid): boolean {
  if (size6 <= 0n) return true;
  if (size6 < toSize6(grid.minOrderSize)) return true;
  const notional6 = (size6 * mark18) / PRICE_SCALE;
  return notional6 < toUsdg6(grid.minOrderNotional || "0");
}

/**
 * ΔS for a buy-in of `assets6`: the buyer's proportional share of the current
 * size, `assets x S / V`, rounded down to the step.
 *
 * Also capped at `assets x L_set / mark` so the order never needs more margin
 * than the buy-in brought -- when the position has lost value its effective
 * leverage sits above L_set, and the cap then gives the buyer slightly less
 * exposure (the shares are still fairly priced at NAV). Below the minimum order
 * size, 0: the buy-in is added as margin only.
 */
export function buyInAddedSize(params: {
  assets6: bigint;
  size6: bigint;
  totalAssets6: bigint;
  leverage: number;
  mark18: bigint;
  grid: MarketGrid;
}): bigint {
  const { assets6, size6, totalAssets6, leverage, mark18, grid } = params;
  if (assets6 <= 0n || size6 <= 0n || totalAssets6 <= 0n || mark18 <= 0n) return 0n;

  const proportional = (assets6 * size6) / totalAssets6;
  const cap = (assets6 * BigInt(leverage) * PRICE_SCALE) / mark18;
  const sized = floorSize6ToStep(proportional < cap ? proportional : cap, grid.stepSize);
  return belowMinimums(sized, mark18, grid) ? 0n : sized;
}

/**
 * The reduce-only size for redeeming `shares` of `supply` (supply taken BEFORE
 * settlement -- it includes the pending shares): `shares / supply x S`, rounded
 * down to the step and never more than the live Arcus leg. Below the minimum
 * order size, 0: the redeem is paid from the token's buffer only.
 */
export function redeemClosedSize(params: {
  shares: bigint;
  supply: bigint;
  size6: bigint;
  /// The live Arcus leg, size6 -- an upper bound.
  legSize6: bigint;
  mark18: bigint;
  grid: MarketGrid;
}): bigint {
  const { shares, supply, size6, legSize6, mark18, grid } = params;
  if (shares <= 0n || supply <= 0n || size6 <= 0n) return 0n;
  const proportional = (shares * size6) / supply;
  const capped = proportional < legSize6 ? proportional : legSize6;
  const sized = floorSize6ToStep(capped, grid.stepSize);
  // A full exit takes the whole leg even if that is under the minimum.
  if (shares === supply && sized > 0n) return sized;
  return belowMinimums(sized, mark18, grid) ? 0n : sized;
}

/// Margin the fill took at `leverage` (notional / L), USDG 6dp, rounded up.
export function marginUsed6(filled6: bigint, price18: bigint, leverage: number): bigint {
  const notional6 = (filled6 * price18) / PRICE_SCALE;
  const lev = BigInt(leverage);
  return (notional6 + lev - 1n) / lev;
}
