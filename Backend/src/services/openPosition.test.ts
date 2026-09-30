import assert from "node:assert/strict";
import test from "node:test";

import type { ArcusMarketInfo } from "../arcus/types";
import { HttpError } from "../lib/errors";
import { checkEntryLiquidity, checkOpenAgainstMarket, sizeEntry } from "./openPosition";

const eth = { arcusDisplayName: "ETH-USD" };

function live(extra: Partial<ArcusMarketInfo> = {}): ArcusMarketInfo {
  return {
    marketId: 2,
    marketDisplayName: "ETH-USD",
    status: "ONLINE",
    baseAsset: "ETH",
    quoteAsset: "USD",
    tickSize: "0.01",
    stepSize: "0.0000001",
    minOrderSize: "0.001",
    maxOrderSize: "100000",
    minOrderNotional: "5",
    markPrice: "2650",
    initialMarginFraction: "0.1",
    offHoursInitialMarginFraction: "0.15",
    isOutsideRth: false,
    ...extra,
  };
}

function rejects(fn: () => void, code: string) {
  assert.throws(fn, (error: unknown) => error instanceof HttpError && error.code === code);
}

test("accepts a valid open", () => {
  checkOpenAgainstMarket(eth, live(), { leverage: 10, amount: "100" });
});

test("rejects an OFFLINE market", () => {
  rejects(() => checkOpenAgainstMarket(eth, live({ status: "OFFLINE" }), { leverage: 2, amount: "100" }), "MARKET_OFFLINE");
});

test("rejects leverage 0 and non-integer leverage", () => {
  rejects(() => checkOpenAgainstMarket(eth, live(), { leverage: 0, amount: "100" }), "INVALID_LEVERAGE");
  rejects(() => checkOpenAgainstMarket(eth, live(), { leverage: 2.5, amount: "100" }), "INVALID_LEVERAGE");
});

test("rejects leverage above the live limit, including off-hours", () => {
  rejects(() => checkOpenAgainstMarket(eth, live(), { leverage: 11, amount: "100" }), "LEVERAGE_TOO_HIGH");
  // 10x is fine in hours, not once Arcus says the market is outside them.
  rejects(
    () => checkOpenAgainstMarket(eth, live({ isOutsideRth: true }), { leverage: 10, amount: "100" }),
    "LEVERAGE_TOO_HIGH",
  );
  checkOpenAgainstMarket(eth, live({ isOutsideRth: true }), { leverage: 6, amount: "100" });
});

test("rejects a position below the minimum size", () => {
  // $4 notional is under the $5 minOrderNotional.
  rejects(() => checkOpenAgainstMarket(eth, live(), { leverage: 2, amount: "2" }), "POSITION_TOO_SMALL");
  // $5 notional clears that, but 0.0018 ETH is under a 0.01 minOrderSize (about $26.50).
  assert.throws(
    () => checkOpenAgainstMarket(eth, live({ minOrderSize: "0.01" }), { leverage: 5, amount: "1" }),
    /Minimum position size for ETH-USD is \$26\.5/,
  );
});

// TSLA off-hours, 2026-09-26: mark pinned at the upper band, every ask beyond it.
const tsla = { arcusDisplayName: "TSLA-USD" };
const pinned = live({
  marketDisplayName: "TSLA-USD",
  markPrice: "394.95",
  isOutsideRth: true,
  upperTradingBound: "394.97",
  lowerTradingBound: "357.37",
  upperExpectedExpansionAt: 1790467457,
});
const tslaBook = {
  bids: [["394.95", "396.99"], ["384.64", "2.59"]] as [string, string][],
  asks: [["398.14", "138.99"], ["398.54", "180.69"]] as [string, string][],
};

test("refuses a long when every ask is beyond the off-hours band", () => {
  rejects(() => checkEntryLiquidity(tsla, pinned, tslaBook, "long"), "OUTSIDE_PRICE_BAND");
});

test("allows a short against a bid inside the band", () => {
  checkEntryLiquidity(tsla, pinned, tslaBook, "short");
});

test("refuses an entry with no liquidity within the slippage bound", () => {
  rejects(() => checkEntryLiquidity(eth, live(), { bids: [], asks: [["9999", "1"]] }, "long"), "NO_LIQUIDITY");
});

test("sizes the entry so margin, fee and worst-case slippage fit the collateral", () => {
  const { quantity } = sizeEntry({
    collateral: "50",
    leverage: 3,
    mark: "393.34",
    side: "SELL",
    market: { tickSize: "0.01", stepSize: "0.0000001" },
  });
  const notional = Number(quantity) * 393.34;
  assert.ok(notional / 3 + notional * 0.00045 + notional * 0.09 <= 50);
  assert.ok(notional > 117); // and still puts nearly all of it to work
});
