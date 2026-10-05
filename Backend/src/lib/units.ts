import { absDecimal, formatDecimal, toBaseUnits } from "./decimal";

/**
 * Laxu's on-chain units -- every value that crosses into or out of the
 * contracts uses these. Venue-specific scales (Perpl's price/lot/collateral
 * decimals) are converted at the venue boundary, in src/venue/perpl/units.ts.
 *
 * Every mismatch here fails silently -- the numbers just come out wrong -- so
 * each unit is fixed once:
 *
 *   Asset amounts (capital, deposits, payouts, totalAssets)  6 decimals   $500 = 500_000_000
 *   Position token shares                                     6 decimals   (same as the asset)
 *   Prices (entry, mark, fill)                                x 1e18       $2,000 = 2000e18
 *   size                                                      base qty x 1e6, always positive
 *   funding (fundingAccrued / fundingSettled)                 signed asset 6dp, positive = received
 *   navPerShare                                               asset per share x 1e18
 *
 * `size x 1e6` is what makes `pnl = size * (mark - entry) / 1e18` land in the
 * asset's 6 decimals: 0.25 ETH on a $200 move is 250000 * 200e18 / 1e18 =
 * 50_000_000 = $50. (PerplReader scales size by 10^collateralDecimals, which
 * is 6 for AUSD -- chain/clients.ts refuses an asset with any other decimals.)
 *
 * Never a JS float for money or prices: decimal strings in, bigints out.
 */

/// The decimals every Laxu amount assumes. assetDecimals() checks the live
/// token against it rather than trusting it.
export const ASSET_DECIMALS_DEFAULT = 6;
export const SIZE_DECIMALS = 6;
export const PRICE_DECIMALS = 18;
export const PRICE_SCALE = 10n ** 18n;

/// "2744.78" -> 2744.78e18. Truncates below 18 places.
export function toPrice18(dec: string): bigint {
  return toBaseUnits(dec, PRICE_DECIMALS);
}

/// "-0.25" or "0.25" -> 250000. The sign is dropped: `direction` carries it.
export function toSize6(dec: string): bigint {
  return toBaseUnits(absDecimal(dec), SIZE_DECIMALS);
}

/// "-2.5" -> -2500000. Signed; truncates toward zero below 6 places.
export function toAsset6(dec: string): bigint {
  return toBaseUnits(dec, ASSET_DECIMALS_DEFAULT);
}

// --- Back to human decimals (API responses) ----------------------------------

export function fromAsset6(x: bigint): string {
  return formatDecimal({ units: x, scale: ASSET_DECIMALS_DEFAULT });
}

export function fromSize6(x: bigint): string {
  return formatDecimal({ units: x, scale: SIZE_DECIMALS });
}

export function fromPrice18(x: bigint): string {
  return formatDecimal({ units: x, scale: PRICE_DECIMALS });
}

/// Fixed number of decimal places, truncated (never rounded up): "1.48",
/// not "1.480000000000000001". For display strings sent to the frontend.
export function toFixedDecimals(units: bigint, scale: number, places: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const shifted = places >= scale ? abs * 10n ** BigInt(places - scale) : abs / 10n ** BigInt(scale - places);
  const digits = shifted.toString().padStart(places + 1, "0");
  const body = places > 0 ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits;
  return negative && shifted !== 0n ? `-${body}` : body;
}

export class UnitsError extends Error {}
