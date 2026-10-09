"use client";

import { useEffect, useState } from "react";
import { useAsset } from "@/lib/asset";
import type { LaxuMarket } from "@/lib/markets";
import { scaleState, useRawMarketStates, type MarketState } from "@/lib/perplMarketData";
import { tokenCountLabel, useTokenCounts, type TokenCounts } from "@/lib/tokenCounts";
import { compactUsd } from "./data";

/**
 * The market stats the trade screen shows, every one read live: 24h volume and
 * open interest from Perpl's market state, funding from its market config, and
 * the Laxu token count from the backend's discovery data. A figure Perpl
 * didn't report is a dash, never a stand-in.
 */

export type MarketStats = {
  state: MarketState | null;
  /** The mark: Perpl's live one, else the backend row's last synced one. Null when neither exists. */
  mark: number | null;
  /** 24h change in percent against Perpl's reference price; null when unknown. */
  changePct: number | null;
  /** Absolute 24h change in USD. */
  changeAbs: number | null;
  volume: string;
  openInterest: string;
  /** "+0.0400%", or a dash. */
  funding: string;
  fundingPositive: boolean | null;
  /** Annualised rate and who pays, for the cell's tooltip. */
  fundingNote: string | null;
  /** "43M", "1H": the funding interval, for the cell label. */
  fundingInterval: string;
  /** Seconds to the next funding event; null when unknown. */
  nextFundingIn: number | null;
  tokens: string;
};

/** Inputs shared by every row: one subscription each, however many rows read them. */
export function useStatsInputs() {
  return { raw: useRawMarketStates(), decimals: useAsset().decimals, counts: useTokenCounts() };
}

const intervalLabel = (sec: number | null) =>
  sec === null ? "—" : sec >= 3600 && sec % 3600 === 0 ? `${sec / 3600}H` : `${Math.round(sec / 60)}M`;

/** The next funding event at or after `now`: the last one plus whole intervals. */
function nextFunding(market: LaxuMarket, now: number): number | null {
  if (market.nextFundingAt === null || !market.fundingIntervalSec) return null;
  const step = market.fundingIntervalSec * 1000;
  let next = market.nextFundingAt;
  if (next < now) next += Math.ceil((now - next) / step) * step;
  return Math.round((next - now) / 1000);
}

/** The mark for a market: Perpl's live one, else the backend row's last synced one; null when neither exists. */
export function markFor(
  market: LaxuMarket,
  raw: ReturnType<typeof useRawMarketStates>,
  decimals: number,
): number | null {
  const live = scaleState(raw[String(market.venueMarketId)], market, decimals)?.mark;
  if (live !== undefined && Number.isFinite(live)) return live;
  const synced = Number(market.markPrice);
  return Number.isFinite(synced) && synced > 0 ? synced : null;
}

export function statsFor(
  market: LaxuMarket | undefined,
  inputs: { raw: ReturnType<typeof useRawMarketStates>; decimals: number; counts: TokenCounts | null },
  now: number,
): MarketStats {
  const state = market ? scaleState(inputs.raw[String(market.venueMarketId)], market, inputs.decimals) : null;
  const mark = market ? markFor(market, inputs.raw, inputs.decimals) : null;
  const prev = state?.prevClose;
  const change = mark !== null && prev && Number.isFinite(prev) && prev > 0 ? { abs: mark - prev, pct: ((mark - prev) / prev) * 100 } : null;
  const rate = market?.fundingRate ?? null;
  return {
    state,
    mark,
    changePct: change?.pct ?? null,
    changeAbs: change?.abs ?? null,
    volume: state ? compactUsd(state.volumeUsd) : "—",
    openInterest: state ? compactUsd(state.openInterestUsd) : "—",
    funding: rate === null ? "—" : `${rate >= 0 ? "+" : "−"}${Math.abs(rate * 100).toFixed(4)}%`,
    fundingPositive: rate === null ? null : rate >= 0,
    fundingNote: rate === null ? null : fundingNote(rate, market?.fundingIntervalSec ?? null),
    fundingInterval: intervalLabel(market?.fundingIntervalSec ?? null),
    nextFundingIn: market && now > 0 ? nextFunding(market, now) : null,
    tokens: market ? tokenCountLabel(inputs.counts, market.baseAsset) : "—",
  };
}

/** "≈ 12.2% a year. Longs pay shorts." Simple annualisation over the funding interval. */
export function fundingNote(rate: number, intervalSec: number | null): string {
  const who = rate > 0 ? "Longs pay shorts." : rate < 0 ? "Shorts pay longs." : "No one pays this interval.";
  if (!intervalSec) return who;
  const yearly = rate * 100 * ((365 * 24 * 3600) / intervalSec);
  return `≈ ${yearly >= 0 ? "" : "−"}${Math.abs(yearly).toFixed(1)}% a year. ${who}`;
}

/** A clock that ticks every `ms`, for countdowns. Starts at 0 on the server so hydration matches. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** "mm:ss" or "h:mm:ss"; a dash when unknown. */
export function countdownLabel(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
