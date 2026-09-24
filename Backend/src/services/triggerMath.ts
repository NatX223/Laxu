import { PRICE_SCALE, toPrice18 } from "../lib/units";

/**
 * Per-holder stop loss / take profit -- the pure half. Mirrors
 * PositionToken's `effectiveTriggers`, `_validateLevels` and `_levelsHit`
 * exactly, so the backend only ever calls `executeTrigger` for a holder the
 * contract will accept.
 *
 * Levels are prices of the underlying at 1e18; 0n = none.
 */

export type Side = "long" | "short";

export interface Levels {
  stopLoss: bigint;
  takeProfit: bigint;
}

export interface EffectiveLevels extends Levels {
  usingDefault: boolean;
}

/// Human price string (or null) -> 1e18, 0n for none.
export function levelOf(value: string | null | undefined): bigint {
  return value ? toPrice18(value) : 0n;
}

/**
 * No row: the defaults, while still active. A row: the holder's own levels --
 * both null means "explicitly none", and the defaults do not apply.
 */
export function effectiveLevels(
  row: { stopLoss: string | null; takeProfit: string | null } | undefined,
  position: { defaultStopLoss: string | null; defaultTakeProfit: string | null; defaultsActive: boolean },
): EffectiveLevels {
  if (row) return { stopLoss: levelOf(row.stopLoss), takeProfit: levelOf(row.takeProfit), usingDefault: false };
  if (position.defaultsActive) {
    return {
      stopLoss: levelOf(position.defaultStopLoss),
      takeProfit: levelOf(position.defaultTakeProfit),
      usingDefault: true,
    };
  }
  return { stopLoss: 0n, takeProfit: 0n, usingDefault: true };
}

/// Long: SL fires at mark <= SL, TP at mark >= TP. Short: the reverse.
export function levelsHit(side: Side, levels: Levels, mark18: bigint): { slHit: boolean; tpHit: boolean } {
  const long = side === "long";
  return {
    slHit: levels.stopLoss !== 0n && (long ? mark18 <= levels.stopLoss : mark18 >= levels.stopLoss),
    tpHit: levels.takeProfit !== 0n && (long ? mark18 >= levels.takeProfit : mark18 <= levels.takeProfit),
  };
}

/// The contract's `_validateLevels` against `ref18` (entry at creation, the
/// current mark for a holder). Returns the revert reason, or null when valid.
export function levelError(side: Side, levels: Levels, ref18: bigint): string | null {
  const { stopLoss: sl, takeProfit: tp } = levels;
  if (side === "long") {
    if (sl !== 0n && sl >= ref18) return "Stop loss must be below the current price for a long";
    if (tp !== 0n && tp <= ref18) return "Take profit must be above the current price for a long";
  } else {
    if (sl !== 0n && sl <= ref18) return "Stop loss must be above the current price for a short";
    if (tp !== 0n && tp >= ref18) return "Take profit must be below the current price for a short";
  }
  return null;
}

/**
 * The aggregate reduce-only fill shared out across the batch in proportion to
 * shares, the last holder taking the rounding remainder so the slices add up
 * to the fill exactly -- the contract's `size` then tracks the Arcus leg.
 */
export function splitClosedSize(filled6: bigint, shares: bigint[]): bigint[] {
  const total = shares.reduce((sum, s) => sum + s, 0n);
  if (shares.length === 0) return [];
  if (total === 0n || filled6 === 0n) return shares.map(() => 0n);
  const slices = shares.map((s) => (filled6 * s) / total);
  const assigned = slices.reduce((sum, s) => sum + s, 0n);
  slices[slices.length - 1] += filled6 - assigned;
  return slices;
}

/**
 * Arcus publishes no liquidation price, so this is an estimate: the mark at
 * which equity `V` falls to the maintenance requirement `MMF x S x M`.
 *
 *   Long:  M - (V - MMF·S·M) / S
 *   Short: M + (V - MMF·S·M) / S
 *
 * `value6` is USDG 6dp, `size6` base x 1e6, prices 1e18. Null when there is
 * no size to liquidate; a long's estimate floors at 0.
 */
export function estLiquidationPrice(params: {
  side: Side;
  value6: bigint;
  size6: bigint;
  mark18: bigint;
  mmf: string;
}): bigint | null {
  const { side, value6, size6, mark18 } = params;
  if (size6 <= 0n || mark18 <= 0n) return null;
  const mmf18 = toPrice18(params.mmf || "0");
  // MMF x S x M in USDG 6dp.
  const maintenance6 = (((mmf18 * size6) / PRICE_SCALE) * mark18) / PRICE_SCALE;
  // (V - maintenance) / S, as a 1e18 price: usdg6 / size6 is dollars per unit.
  const cushion18 = ((value6 - maintenance6) * PRICE_SCALE) / size6;
  const price = side === "long" ? mark18 - cushion18 : mark18 + cushion18;
  return price > 0n ? price : 0n;
}
