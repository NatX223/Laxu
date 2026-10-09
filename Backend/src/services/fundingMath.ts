import type { ApiFundingEvent } from "../venue/perpl/types";

/**
 * Perpl funding rates, pure. Units (types.md FundingEvent, checked on testnet
 * against `ppl` = idx x rate / 10^6 for every market):
 *
 *   rate      micros (10^-6) per funding interval
 *   percent   rate / 10^4                         (10 micros = 0.001%)
 *   annual    percent x (365 x 86400 / funding_interval_sec), simple, not compounded
 *
 * Sign (exchange/funding.md): "positive (payment flows from long positions to
 * short positions) or negative (payment flows in the opposite direction)".
 */

export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
/// Perpl allows 1024 intervals per request; stay under it.
export const MAX_INTERVALS_PER_REQUEST = 1000;

export interface FundingPoint {
  /// ms: when the rate applies.
  time: number;
  /// Funding event block (`feb`): identifies the interval.
  block: number;
  /// Raw rate, micros per interval.
  rateMicros: number;
  /// Percent per funding interval (0.001 = 0.001%).
  ratePct: number;
  /// Simple annualised percent.
  annualizedPct: number;
  /// Index price, human.
  indexPrice: number;
  /// The rate applies in the future: `time` is Perpl's estimate, corrected
  /// within about a minute.
  estimatedTime: boolean;
}

export function ratePct(rateMicros: number): number {
  return rateMicros / 10_000;
}

export function annualizedPct(rateMicros: number, intervalSec: number): number {
  return intervalSec > 0 ? ratePct(rateMicros) * (SECONDS_PER_YEAR / intervalSec) : 0;
}

export function toFundingPoint(event: ApiFundingEvent, intervalSec: number, priceDecimals: number, nowMs: number): FundingPoint {
  const time = event.at?.t ?? 0;
  return {
    time,
    block: event.feb,
    rateMicros: event.rate,
    ratePct: ratePct(event.rate),
    annualizedPct: annualizedPct(event.rate, intervalSec),
    indexPrice: event.idx / 10 ** priceDecimals,
    estimatedTime: time > nowMs,
  };
}

/// [from, to] split into requests of at most MAX_INTERVALS_PER_REQUEST intervals each.
export function chunkRange(fromMs: number, toMs: number, intervalSec: number): Array<[number, number]> {
  const step = MAX_INTERVALS_PER_REQUEST * intervalSec * 1000;
  const chunks: Array<[number, number]> = [];
  for (let start = fromMs; start <= toMs; start += step + 1) chunks.push([start, Math.min(toMs, start + step)]);
  return chunks;
}

/// Oldest first, one event per `feb`; a repeated `feb` is the same interval
/// republished with its exact time, so the later copy wins.
export function dedupeByFeb(events: ApiFundingEvent[]): ApiFundingEvent[] {
  const byFeb = new Map<number, ApiFundingEvent>();
  for (const event of events) byFeb.set(event.feb, event);
  return [...byFeb.values()].sort((a, b) => a.feb - b.feb);
}

/// "Longs pay shorts" etc. for a rate, in plain words.
export function whoPays(rateMicros: number): "longs pay shorts" | "shorts pay longs" | "no funding" {
  if (rateMicros > 0) return "longs pay shorts";
  if (rateMicros < 0) return "shorts pay longs";
  return "no funding";
}
