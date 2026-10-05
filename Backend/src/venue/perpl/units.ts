import { assetDecimals } from "../../chain/clients";
import { formatDecimal, toBaseUnits } from "../../lib/decimal";
import { PRICE_DECIMALS, SIZE_DECIMALS } from "../../lib/units";
import { readExchangeInfo } from "./exchange";

/**
 * Every Perpl <-> Laxu unit conversion, and nothing else. Pure functions take
 * the scale they need explicitly; {collateralScale} reads (once) the two
 * collateral scales that come from the chain.
 *
 *   Perpl                                  Laxu
 *   price  p   (x 10^priceDecimals)   ->   price18 = p x 10^(18 - pd)
 *   size   lots (x 10^sizeDecimals)   ->   size6   = lots x 10^6 / 10^sd   (floor)
 *   collateral CNS (x 10^collateralDecimals, from getExchangeInfo)
 *                                      ->   asset   = cns x 10^(assetDec - cnsDec)
 *
 * API `Market.config.price_decimals` / `size_decimals` equal the on-chain
 * `priceDecimals` / `lotDecimals`; marketSync checks that once per market.
 * `collateralDecimals` may differ from the token's own `decimals()`, so the
 * two are kept apart here. (PerplReader scales size by 10^collateralDecimals;
 * Laxu's size6 equals it only while that is 6 -- {collateralScale} alerts
 * otherwise.)
 */

export interface CollateralScale {
  /// `getExchangeInfo().collateralDecimals` -- the scale of every `*CNS` value.
  cnsDecimals: number;
  /// The asset token's `decimals()`.
  assetDecimals: number;
}

let scaleCache: Promise<CollateralScale> | undefined;

export function collateralScale(): Promise<CollateralScale> {
  scaleCache ??= (async () => {
    const [info, tokenDecimals] = await Promise.all([readExchangeInfo(), assetDecimals()]);
    const cnsDecimals = Number(info.collateralDecimals);
    if (cnsDecimals !== SIZE_DECIMALS) {
      // PerplReader.toSize uses 10^collateralDecimals; Laxu's size6 uses 10^6.
      // They only agree at 6 -- a mismatch would fail every createPosition.
      throw new Error(
        `Perpl collateralDecimals is ${cnsDecimals}; Laxu's size6 (and PerplReader's size scale) assume ${SIZE_DECIMALS}`,
      );
    }
    return { cnsDecimals, assetDecimals: tokenDecimals };
  })().catch((error) => {
    scaleCache = undefined;
    throw error;
  });
  return scaleCache;
}

function pow10(exp: number): bigint {
  return 10n ** BigInt(exp);
}

// --- Collateral ----------------------------------------------------------------

/// CNS -> asset base units. Floors when shrinking (cnsDec > assetDec).
export function cnsToAsset(cns: bigint, scale: CollateralScale): bigint {
  const diff = scale.assetDecimals - scale.cnsDecimals;
  return diff >= 0 ? cns * pow10(diff) : cns / pow10(-diff);
}

/// Asset base units -> CNS. Floors when shrinking (assetDec > cnsDec), so a
/// deposit/withdraw never asks for more than the asset amount covers.
export function assetToCns(asset: bigint, scale: CollateralScale): bigint {
  const diff = scale.cnsDecimals - scale.assetDecimals;
  return diff >= 0 ? asset * pow10(diff) : asset / pow10(-diff);
}

/**
 * An API `Amount` string (balances, fees, collateral, min amounts) -> CNS.
 *
 * VERIFY(spec03): the docs type `Amount` only as "decimal string for large
 * numbers" and never say whether it is a base-unit integer or a human decimal
 * (`min_account_open_amount: 100000000` displayed as "10.0 AUSD" fits neither
 * 6 nor 8 decimals cleanly). Default: an integer string is CNS base units; a
 * string with a decimal point is read as a human amount at cnsDecimals.
 */
export function parseApiAmount(value: string | number | null | undefined, cnsDecimals: number): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  const text = String(value).trim();
  if (/^-?\d+$/.test(text)) return BigInt(text);
  return toBaseUnits(text, cnsDecimals);
}

/// An API Amount straight to asset base units.
export function apiAmountToAsset(value: string | number | null | undefined, scale: CollateralScale): bigint {
  return cnsToAsset(parseApiAmount(value, scale.cnsDecimals), scale);
}

/// Asset base units -> the API `a` Amount string (CNS integer). See the
/// VERIFY on {parseApiAmount}: the same unit question applies to what we send.
export function assetToApiAmount(asset: bigint, scale: CollateralScale): string {
  return assetToCns(asset, scale).toString();
}

// --- Price -----------------------------------------------------------------------

export function pnsToPrice18(pns: bigint | number, priceDecimals: number): bigint {
  const value = BigInt(pns);
  const diff = PRICE_DECIMALS - priceDecimals;
  return diff >= 0 ? value * pow10(diff) : value / pow10(-diff);
}

/// 1e18 -> Perpl scaled price, floored.
export function price18ToPns(price18: bigint, priceDecimals: number): bigint {
  const diff = PRICE_DECIMALS - priceDecimals;
  return diff >= 0 ? price18 / pow10(diff) : price18 * pow10(-diff);
}

/// Perpl scaled price -> human decimal string ("2744.5").
export function pnsToDecimal(pns: bigint | number, priceDecimals: number): string {
  return formatDecimal({ units: BigInt(pns), scale: priceDecimals });
}

// --- Size ------------------------------------------------------------------------

/// Lots -> size6, floored: `lots x 10^6 / 10^sd`. Identical integer maths to
/// PerplReader.toSize while collateralDecimals is 6 (see {collateralScale}).
export function lotsToSize6(lots: bigint | number, sizeDecimals: number): bigint {
  return (BigInt(lots) * pow10(SIZE_DECIMALS)) / pow10(sizeDecimals);
}

/// size6 -> lots, floored: `size6 x 10^sd / 10^6`.
export function size6ToLots(size6: bigint, sizeDecimals: number): bigint {
  return (size6 * pow10(sizeDecimals)) / pow10(SIZE_DECIMALS);
}

/// 10^-decimals as a decimal string ("0.01" for 2) -- tickSize / stepSize.
export function stepOf(decimals: number): string {
  return formatDecimal({ units: 1n, scale: decimals });
}

// --- Direction ---------------------------------------------------------------------

export type VenueDirection = "long" | "short";

/// API `Position.sd`: 1 = Long, 2 = Short.
export function apiSideToDirection(sd: number): VenueDirection {
  if (sd === 1) return "long";
  if (sd === 2) return "short";
  throw new Error(`Unknown API position side ${sd}`);
}

/// On-chain `PositionInfo.positionType`: 0 = Long, 1 = Short.
export function chainTypeToDirection(positionType: number): VenueDirection {
  if (positionType === 0) return "long";
  if (positionType === 1) return "short";
  throw new Error(`Unknown on-chain position type ${positionType}`);
}

// --- Margin & leverage ---------------------------------------------------------------

/// Laxu's own ceiling (LendingPool risk tiers stop at 20x).
export const LAXU_MAX_LEVERAGE = 20;

/**
 * `initial_margin` is in 1e4 units: 1000 = 10% = 10x. Laxu caps at 20x.
 * A missing or nonsensical value never widens the limit.
 */
export function maxLeverageFromInitialMargin(initialMargin: number): number {
  if (!Number.isFinite(initialMargin) || initialMargin <= 0) return 1;
  return Math.max(1, Math.min(LAXU_MAX_LEVERAGE, Math.floor(10_000 / initialMargin)));
}

/**
 * A Perpl margin `Fraction` -> a decimal fraction string ("0.1" for 1000).
 *
 * VERIFY(spec03): `maintenance_margin` is assumed to use the same 1e4 scale as
 * `initial_margin`. The docs' own example ("2000 = 5%") does not fit that scale.
 */
export function marginFraction(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return formatDecimal({ units: BigInt(Math.round(value)), scale: 4 });
}

/// Taker fee micros (1000 = 0.1%) -> parts per million, the unit sizing uses.
export function feeMicrosToPpm(micros: number): number {
  return Math.max(0, Math.round(micros));
}

// --- Time -------------------------------------------------------------------------

/// API `at.t` is milliseconds; on-chain timestamps are seconds.
export function apiMsToDate(ms: number | undefined): Date | undefined {
  return ms === undefined ? undefined : new Date(ms);
}
