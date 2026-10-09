import { perplReaderAbi } from "../../chain/abi";
import { assetDecimals, publicClient, readerAddress } from "../../chain/clients";
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
 * two are kept apart here and CNS <-> asset works for any pair of them.
 * Opening a position has one scale constraint of its own, on the ASSET's
 * decimals -- see {assertPnlScaleSupported}.
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
    return { cnsDecimals: Number(info.collateralDecimals), assetDecimals: tokenDecimals };
  })().catch((error) => {
    scaleCache = undefined;
    throw error;
  });
  return scaleCache;
}

/**
 * Known constraint (opening only -- never boot, deposit, withdraw or settle):
 * the contract's PnL scale is the ASSET's decimals. PositionToken values a
 * position as
 *
 *   totalAssets = capital + size * (mark - entry) / 1e18
 *
 * with `capital` in asset base units, so `size` must be in 10^assetDecimals
 * units for the PnL to land in the asset too. Laxu's size6 fixes that at 6
 * (AUSD), and the deployed PerplReader sizes positions at its immutable
 * `sizeScale` (lns * sizeScale / 10^lotDecimals, set at deploy), which
 * PositionToken.initialize compares to the size we pass with no tolerance.
 * So opening needs  assetDecimals == 6  and  reader.sizeScale() == 10^assetDecimals.
 * Both hold on testnet (AUSD, 6; sizeScale 1e6); another asset would need a
 * new reader and a size unit derived from its decimals.
 */
export function assertPnlScaleSupported(tokenDecimals: number, readerSizeScale: bigint): void {
  if (tokenDecimals !== SIZE_DECIMALS || readerSizeScale !== 10n ** BigInt(tokenDecimals)) {
    throw new Error(
      `cannot open positions: the asset has ${tokenDecimals} decimals and PerplReader sizes at ${readerSizeScale}; ` +
        `PositionToken's PnL (size x price / 1e18, added to capital in asset units) needs both at 10^${SIZE_DECIMALS}`,
    );
  }
}

let pnlScaleCache: Promise<void> | undefined;

/// {assertPnlScaleSupported} against the live asset and the deployed reader (read once).
export function assertOpenScale(): Promise<void> {
  pnlScaleCache ??= (async () => {
    const [tokenDecimals, sizeScale] = await Promise.all([
      assetDecimals(),
      publicClient().readContract({ address: readerAddress(), abi: perplReaderAbi, functionName: "sizeScale" }) as Promise<bigint>,
    ]);
    assertPnlScaleSupported(tokenDecimals, sizeScale);
  })().catch((error) => {
    pnlScaleCache = undefined;
    throw error;
  });
  return pnlScaleCache;
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
 * A string with a decimal point (never seen) is read as a human amount at cnsDecimals.
 */
// Confirmed on testnet 2026-10-05: an API Amount is a CNS base-unit integer string -- min_account_open_amount "100000000" == getMinAccountOpenCNS() (docs/perpl-findings.md#v-units-75)
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

/// Asset base units -> the API `a` Amount string (CNS integer, see {parseApiAmount}).
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
/// PerplReader.toSize while its sizeScale is 1e6 (see {assertPnlScaleSupported}).
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

// Confirmed on testnet 2026-10-05: initial_margin / maintenance_margin are max leverage in hundredths (ETH 1200 = 12x); lv above it is silently clamped (docs/perpl-findings.md#v-units-171)

/**
 * `initial_margin` is the market's max leverage in hundredths: 1200 = 12x.
 * Laxu caps at 20x. A missing or nonsensical value never widens the limit.
 */
export function maxLeverageFromInitialMargin(initialMargin: number): number {
  if (!Number.isFinite(initialMargin) || initialMargin <= 0) return 1;
  return Math.max(1, Math.min(LAXU_MAX_LEVERAGE, Math.floor(initialMargin / 100)));
}

/// Digits kept in a margin fraction. Truncating (never rounding up) keeps
/// floor(1 / fraction) exact for every integer leverage-in-hundredths, which
/// is how markets.maxLeverage reads it back.
const FRACTION_SCALE = 12;

/**
 * A Perpl margin field (max leverage in hundredths) -> the margin fraction
 * as a decimal string: 100 / value, truncated. 1200 (12x) -> "0.083333333333",
 * 2000 (20x) -> "0.05", 1000 -> "0.1".
 */
export function marginFraction(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const units = (100n * 10n ** BigInt(FRACTION_SCALE)) / BigInt(Math.round(value));
  return formatDecimal({ units, scale: FRACTION_SCALE });
}

/// Taker fee micros (1000 = 0.1%) -> parts per million, the unit sizing uses.
export function feeMicrosToPpm(micros: number): number {
  return Math.max(0, Math.round(micros));
}

// --- Exchange minimums ----------------------------------------------------------

/**
 * Perpl's minimum deposit for the exchange at `exchange`, as the API Amount
 * string (`instances[].min_deposit_amount`, CNS; "10000000" = 10 AUSD on
 * testnet). The exchange refuses a smaller `depositCollateral`, so an open
 * below it could never reach the order. The trade ticket reads the same field
 * (App/src/lib/markets.ts). Throws when the context lists no such exchange.
 */
export function exchangeMinDeposit(
  instances: ReadonlyArray<{ address: string; min_deposit_amount: string }>,
  exchange: string,
): string {
  const instance = instances.find((i) => i.address.toLowerCase() === exchange.toLowerCase());
  if (!instance) throw new Error(`Perpl context lists no exchange instance at ${exchange}`);
  return instance.min_deposit_amount ?? "0";
}

// --- Time -------------------------------------------------------------------------

/// API `at.t` is milliseconds; on-chain timestamps are seconds.
export function apiMsToDate(ms: number | undefined): Date | undefined {
  return ms === undefined ? undefined : new Date(ms);
}
