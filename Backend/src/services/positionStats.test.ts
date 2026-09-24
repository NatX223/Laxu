import assert from "node:assert/strict";
import test from "node:test";

import { toPrice18, toSize6, toUsdg6 } from "../lib/units";
import { derivePositionStats, holderAddresses, type StatsInput } from "./positionStats";

const E18 = 10n ** 18n;
const now = new Date("2026-09-23T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

const POOL = "0x00000000000000000000000000000000000000p1";
const CREATOR = "0x00000000000000000000000000000000000000c1";
const BUYER = "0x00000000000000000000000000000000000000b1";
const BORROWER = "0x00000000000000000000000000000000000000d1";

/**
 * Fixture: open $500 at 5x (1.25 ETH @ 2000) -> creator top-up is not a buy-in
 * -> buyer buys in $102 gross ($100 net + $2 fee) at NAV 1.0 -> redeems half
 * -> mark moves. The chain block is what the contract reports afterwards.
 */
function fixture(overrides: Partial<StatsInput> = {}): StatsInput {
  return {
    chain: {
      size: toSize6("1.375"),
      markPrice: toPrice18("2200"),
      totalAssets: toUsdg6("824"),
      totalSupply: toUsdg6("550"),
      fundingAccrued: toUsdg6("-3"),
      fundingSettled: toUsdg6("-1"),
    },
    open: true,
    maintenanceMarginFraction: "0.0267",
    holdings: [
      { address: CREATOR, balance: toUsdg6("500").toString() },
      { address: BUYER, balance: "0" },
      { address: POOL, balance: toUsdg6("50").toString() },
    ],
    poolAddresses: [POOL],
    borrowers: [{ address: BORROWER, collateralShares: toUsdg6("50").toString(), debt: toUsdg6("20").toString() }],
    flows: [
      { type: "open", address: CREATOR, assets: toUsdg6("500").toString(), feeAssets: "0", timestamp: hoursAgo(48) },
      { type: "top_up", address: CREATOR, assets: toUsdg6("25").toString(), feeAssets: "0", timestamp: hoursAgo(30) },
      { type: "buy_in", address: BUYER, assets: toUsdg6("100").toString(), feeAssets: toUsdg6("2").toString(), timestamp: hoursAgo(30) },
      { type: "buy_in", address: BUYER, assets: toUsdg6("49").toString(), feeAssets: toUsdg6("1").toString(), timestamp: hoursAgo(2) },
      { type: "buy_in", address: BORROWER, assets: toUsdg6("49").toString(), feeAssets: toUsdg6("1").toString(), timestamp: hoursAgo(1) },
      { type: "redeem", address: BUYER, assets: toUsdg6("74").toString(), feeAssets: "0", timestamp: hoursAgo(1) },
    ],
    now,
    ...overrides,
  };
}

test("stats on the open -> buy-in -> redeem -> mark move fixture", () => {
  const stats = derivePositionStats(fixture());
  // 824 / 550 = 1.498181...
  assert.equal(stats.navPerShare, (824n * E18) / 550n);
  assert.equal(stats.pnlBps, 4981);
  // 1.375 x 2200 = 3025 notional / 824 = 3.67x
  assert.equal(stats.effectiveLeverage, "3.67");
  assert.equal(stats.fundingNet, toUsdg6("-2"));
  // buy_in only, gross: 102 + 50 + 50
  assert.equal(stats.buyInVolume, toUsdg6("202"));
  assert.equal(stats.buyInVolume24h, toUsdg6("100"));
  assert.equal(stats.buyerCount24h, 2);
  // creator + borrower; the pool is not a holder, the zero-balance buyer is gone
  assert.equal(stats.holderCount, 2);
  assert.equal(stats.isCollateralized, true);
  assert.equal(stats.isAtRisk, false);
});

test("a holder with everything posted as collateral still counts; the pool never does", () => {
  const holders = holderAddresses(
    [
      { address: BORROWER, balance: "0" },
      { address: POOL, balance: toUsdg6("50").toString() },
    ],
    [POOL],
    [{ address: BORROWER, collateralShares: toUsdg6("50").toString(), debt: "0" }],
  );
  assert.deepEqual([...holders], [BORROWER]);
});

test("at risk exactly below 1.5 x maintenance margin", () => {
  // notional 3025; 1.5 x 2.67% = 4.005% -> threshold equity 121.15125
  const at = (equity: string) =>
    derivePositionStats(fixture({ chain: { ...fixture().chain, totalAssets: toUsdg6(equity) } })).isAtRisk;
  assert.equal(at("121.16"), false);
  assert.equal(at("121.15"), true);
  // A closed position is never "at risk".
  assert.equal(derivePositionStats(fixture({ open: false, chain: { ...fixture().chain, totalAssets: toUsdg6("100") } })).isAtRisk, false);
});

test("an empty supply reads as genesis NAV", () => {
  const stats = derivePositionStats(fixture({ chain: { ...fixture().chain, totalAssets: 0n, totalSupply: 0n } }));
  assert.equal(stats.navPerShare, E18);
  assert.equal(stats.pnlBps, 0);
});
