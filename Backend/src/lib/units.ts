import { absDecimal, formatDecimal, parseDecimal, toBaseUnits } from "./decimal";

/**
 * The ONLY place that converts between Arcus's formats and on-chain units.
 *
 * Every mismatch here fails silently -- the numbers just come out wrong -- so
 * each unit is fixed once:
 *
 *   USDG amounts (capital, deposits, payouts, totalAssets)  6 decimals   $500 = 500_000_000
 *   Position token shares                                     6 decimals   (same as USDG)
 *   Prices (entry, mark, fill)                                x 1e18       $2,000 = 2000e18
 *   size                                                      base qty x 1e6, always positive
 *   funding (fundingAccrued / fundingSettled)                 signed USDG 6dp, positive = received
 *   navPerShare                                               USDG per share x 1e18
 *   Arcus POST /v1/withdraw `amount`                          quote quantums, 1e9 = $1
 *
 * `size x 1e6` is what makes `pnl = size * (mark - entry) / 1e18` land in
 * USDG's 6 decimals: 0.25 ETH on a $200 move is 250000 * 200e18 / 1e18 =
 * 50_000_000 = $50.
 *
 * Never a JS float for money or prices: decimal strings in, bigints out.
 */

export const USDG_DECIMALS = 6;
export const SIZE_DECIMALS = 6;
export const PRICE_DECIMALS = 18;
export const PRICE_SCALE = 10n ** 18n;

/// Arcus quote quantums per USDG base unit: 1e9 per dollar / 1e6 per dollar.
const QUANTUMS_PER_USDG_UNIT = 1_000n;

/// "2744.78" -> 2744.78e18. Truncates below 18 places.
export function toPrice18(dec: string): bigint {
  return toBaseUnits(dec, PRICE_DECIMALS);
}

/// "-0.25" or "0.25" -> 250000. The sign is dropped: `direction` carries it.
export function toSize6(dec: string): bigint {
  return toBaseUnits(absDecimal(dec), SIZE_DECIMALS);
}

/// "-2.5" -> -2500000. Signed; truncates toward zero below 6 places.
export function toUsdg6(dec: string): bigint {
  return toBaseUnits(dec, USDG_DECIMALS);
}

export function usdg6ToArcusQuantums(x: bigint): bigint {
  return x * QUANTUMS_PER_USDG_UNIT;
}

/// Quote quantums -> USDG base units, truncated.
export function arcusQuantumsToUsdg6(q: bigint): bigint {
  return q / QUANTUMS_PER_USDG_UNIT;
}

// --- Back to human decimals (API responses, Arcus request bodies) -----------

export function fromUsdg6(x: bigint): string {
  return formatDecimal({ units: x, scale: USDG_DECIMALS });
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

// --- Arcus position rows -----------------------------------------------------

/// The subset of a GET /v1/positions row (or a positions-channel snapshot row)
/// the conversions need. Side arrives as BUY/SELL on REST and LONG/SHORT on the
/// stream.
export interface ArcusPositionRowLike {
  size: string;
  averageEntryPrice: string;
  markPrice?: string;
  cumulativeFunding?: { sinceOpen?: string };
}

/**
 * Values at or above this are assumed to be engine quantums rather than
 * decimals. The docs' own example mixes "97500.5" with "50000000000", so the
 * format is unverified -- any row this trips is logged and rejected by the
 * caller rather than guessed at. Run `npm run smoke -- units <slotId>` to see
 * the raw row.
 */
const SUSPICIOUS_INTEGER = 10n ** 9n;

export class UnitsError extends Error {}

function looksLikeQuantums(value: string): boolean {
  const parsed = parseDecimal(value);
  return parsed.scale === 0 && (parsed.units < 0n ? -parsed.units : parsed.units) >= SUSPICIOUS_INTEGER;
}

/**
 * One place for the "are position rows decimals or quantums" question.
 * `fallbackMark` is used when the row carries no mark (REST rows don't always).
 */
export function fromArcusPositionRow(
  row: ArcusPositionRowLike,
  fallbackMark?: string,
): { size6: bigint; entry18: bigint; mark18: bigint | null; funding6: bigint } {
  for (const [field, value] of [
    ["size", row.size],
    ["averageEntryPrice", row.averageEntryPrice],
  ] as const) {
    if (looksLikeQuantums(value)) {
      throw new UnitsError(
        `Arcus position ${field} "${value}" looks like engine quantums, not a decimal -- verify the parser before trading on it`,
      );
    }
  }
  const mark = row.markPrice && row.markPrice !== "0" ? row.markPrice : fallbackMark;
  return {
    size6: toSize6(row.size),
    entry18: toPrice18(row.averageEntryPrice),
    mark18: mark ? toPrice18(mark) : null,
    funding6: toUsdg6(row.cumulativeFunding?.sinceOpen ?? "0"),
  };
}
