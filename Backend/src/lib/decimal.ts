/**
 * Exact decimal arithmetic on strings, backed by BigInt.
 *
 * Money and order sizes never touch a float here. Two conversions in particular
 * have to be exact or the order is rejected outright:
 *
 *   - price / tickSize  -> the signed `p` integer (ticks)
 *   - size  / stepSize  -> the signed `q` integer (quantums)
 *
 * Arcus requires those divisions to have no remainder, so `divideExact` throws
 * rather than rounding -- a rounded tick produces a signature over a price the
 * caller never intended.
 */

export interface Decimal {
  /// Unscaled integer value.
  units: bigint;
  /// Number of decimal places `units` is scaled by.
  scale: number;
}

const DECIMAL_RE = /^-?(?:\d+)(?:\.\d+)?$/;

export function parseDecimal(input: string): Decimal {
  const raw = input.trim();
  if (!DECIMAL_RE.test(raw)) {
    throw new Error(`Not a decimal string: ${JSON.stringify(input)}`);
  }
  const negative = raw.startsWith("-");
  const body = negative ? raw.slice(1) : raw;
  const [whole, fraction = ""] = body.split(".");
  const units = BigInt(whole + fraction);
  return { units: negative ? -units : units, scale: fraction.length };
}

function rescale(value: Decimal, scale: number): bigint {
  if (scale < value.scale) throw new Error("rescale: cannot reduce scale without loss");
  return value.units * 10n ** BigInt(scale - value.scale);
}

function align(a: Decimal, b: Decimal): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return { a: rescale(a, scale), b: rescale(b, scale), scale };
}

export function formatDecimal(value: Decimal): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, "0");
  const whole = digits.slice(0, digits.length - value.scale) || "0";
  const fraction = value.scale > 0 ? digits.slice(digits.length - value.scale) : "";
  const trimmed = fraction.replace(/0+$/, "");
  const body = trimmed ? `${whole}.${trimmed}` : whole;
  return negative && body !== "0" ? `-${body}` : body;
}

/// `a / b` where the result must be a whole number. Used for ticks and quantums.
export function divideExact(a: string, b: string): bigint {
  const { a: left, b: right } = align(parseDecimal(a), parseDecimal(b));
  if (right === 0n) throw new Error("divideExact: division by zero");
  if (left % right !== 0n) {
    throw new Error(`${a} is not an exact multiple of ${b}`);
  }
  return left / right;
}

/// `a / b` rounded toward zero, plus the remainder -- for quantities where the
/// exchange grid, not the caller, decides the achievable size.
export function divideFloor(a: string, b: string): { quotient: bigint; exact: boolean } {
  const { a: left, b: right } = align(parseDecimal(a), parseDecimal(b));
  if (right === 0n) throw new Error("divideFloor: division by zero");
  return { quotient: left / right, exact: left % right === 0n };
}

/// Largest multiple of `step` that is <= `value`. Returned as a decimal string.
export function floorToStep(value: string, step: string): string {
  const parsedStep = parseDecimal(step);
  const { quotient } = divideFloor(value, step);
  return multiplyByInteger(parsedStep, quotient);
}

/// Smallest multiple of `step` that is >= `value`. The pair matters for
/// protective price bounds: flooring a SELL bound pushes it further from mark
/// and can breach the 10% slippage limit, so each side rounds the safe way.
export function ceilToStep(value: string, step: string): string {
  const parsedStep = parseDecimal(step);
  const { quotient, exact } = divideFloor(value, step);
  return multiplyByInteger(parsedStep, exact ? quotient : quotient + 1n);
}

function multiplyByInteger(value: Decimal, factor: bigint): string {
  return formatDecimal({ units: value.units * factor, scale: value.scale });
}

export function compareDecimal(a: string, b: string): number {
  const { a: left, b: right } = align(parseDecimal(a), parseDecimal(b));
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function addDecimal(a: string, b: string): string {
  const { a: left, b: right, scale } = align(parseDecimal(a), parseDecimal(b));
  return formatDecimal({ units: left + right, scale });
}

export function subtractDecimal(a: string, b: string): string {
  const { a: left, b: right, scale } = align(parseDecimal(a), parseDecimal(b));
  return formatDecimal({ units: left - right, scale });
}

export function absDecimal(a: string): string {
  const parsed = parseDecimal(a);
  return formatDecimal({ units: parsed.units < 0n ? -parsed.units : parsed.units, scale: parsed.scale });
}

export function negateDecimal(a: string): string {
  const parsed = parseDecimal(a);
  return formatDecimal({ units: -parsed.units, scale: parsed.scale });
}

export function isZeroDecimal(a: string): boolean {
  return parseDecimal(a).units === 0n;
}

/// Apply a basis-point adjustment: `value * (10000 + bps) / 10000`, truncated to
/// `scale` decimal places.
export function applyBps(value: string, bps: number, scale: number): string {
  const parsed = parseDecimal(value);
  const scaled = rescale(parsed, Math.max(parsed.scale, scale));
  const resultScale = Math.max(parsed.scale, scale);
  const adjusted = (scaled * BigInt(10_000 + bps)) / 10_000n;
  return formatDecimal({ units: adjusted, scale: resultScale });
}

// ---------------------------------------------------------------------------
// Fixed-point bridges between chain base units and human decimal strings.
// ---------------------------------------------------------------------------

/// Base units (e.g. USDG wei) -> human decimal string.
export function fromBaseUnits(units: bigint, decimals: number): string {
  return formatDecimal({ units, scale: decimals });
}

/// Human decimal string -> base units, truncating anything below `decimals`.
export function toBaseUnits(value: string, decimals: number): bigint {
  const parsed = parseDecimal(value);
  if (parsed.scale <= decimals) return rescale(parsed, decimals);
  const divisor = 10n ** BigInt(parsed.scale - decimals);
  return parsed.units / divisor;
}
