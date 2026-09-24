import assert from "node:assert/strict";
import test from "node:test";

import type { ArcusMarketInfo } from "../arcus/types";
import { HttpError } from "../lib/errors";
import { checkOpenAgainstMarket } from "./openPosition";

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
