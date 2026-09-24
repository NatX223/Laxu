import assert from "node:assert/strict";
import test from "node:test";

import { PRICE_SCALE } from "../lib/units";
import { redeemClosedSize } from "./sizing";
import { effectiveLevels, estLiquidationPrice, levelError, levelsHit, splitClosedSize } from "./triggerMath";

const P = (n: bigint) => n * PRICE_SCALE;
const USD = 1_000_000n;
const UNIT = 1_000_000n; // size6

const defaults = { defaultStopLoss: "1900", defaultTakeProfit: "2400", defaultsActive: true };

test("effective levels: defaults, custom, explicit none, and retired defaults", () => {
  assert.deepEqual(effectiveLevels(undefined, defaults), { stopLoss: P(1900n), takeProfit: P(2400n), usingDefault: true });
  assert.deepEqual(effectiveLevels({ stopLoss: "1950", takeProfit: null }, defaults), {
    stopLoss: P(1950n),
    takeProfit: 0n,
    usingDefault: false,
  });
  // Cleared: a row with no levels means none -- NOT the defaults.
  assert.deepEqual(effectiveLevels({ stopLoss: null, takeProfit: null }, defaults), {
    stopLoss: 0n,
    takeProfit: 0n,
    usingDefault: false,
  });
  assert.deepEqual(effectiveLevels(undefined, { ...defaults, defaultsActive: false }), {
    stopLoss: 0n,
    takeProfit: 0n,
    usingDefault: true,
  });
});

test("levels fire on the right side for each direction", () => {
  const levels = { stopLoss: P(1900n), takeProfit: P(2400n) };
  assert.deepEqual(levelsHit("long", levels, P(1900n)), { slHit: true, tpHit: false });
  assert.deepEqual(levelsHit("long", levels, P(2000n)), { slHit: false, tpHit: false });
  assert.deepEqual(levelsHit("long", levels, P(2400n)), { slHit: false, tpHit: true });

  const short = { stopLoss: P(2100n), takeProfit: P(1800n) };
  assert.deepEqual(levelsHit("short", short, P(2150n)), { slHit: true, tpHit: false });
  assert.deepEqual(levelsHit("short", short, P(1790n)), { slHit: false, tpHit: true });
  assert.deepEqual(levelsHit("short", { stopLoss: 0n, takeProfit: 0n }, P(1n)), { slHit: false, tpHit: false });
});

test("level validation matches the contract: wrong side or already breached is rejected", () => {
  assert.equal(levelError("long", { stopLoss: P(1900n), takeProfit: P(2400n) }, P(2000n)), null);
  assert.match(levelError("long", { stopLoss: P(2000n), takeProfit: 0n }, P(2000n)) ?? "", /below/);
  assert.match(levelError("long", { stopLoss: 0n, takeProfit: P(1990n) }, P(2000n)) ?? "", /above/);
  assert.equal(levelError("short", { stopLoss: P(2100n), takeProfit: P(1800n) }, P(2000n)), null);
  assert.match(levelError("short", { stopLoss: P(1900n), takeProfit: 0n }, P(2000n)) ?? "", /above/);
  assert.match(levelError("short", { stopLoss: 0n, takeProfit: P(2100n) }, P(2000n)) ?? "", /below/);
});

test("the fill is split by shares and the slices add up to it exactly", () => {
  const slices = splitClosedSize(1_000_001n, [300n, 200n, 7n]);
  assert.equal(slices.reduce((a, b) => a + b, 0n), 1_000_001n);
  assert.deepEqual(slices.slice(0, 2), [(1_000_001n * 300n) / 507n, (1_000_001n * 200n) / 507n]);
  assert.deepEqual(splitClosedSize(0n, [1n, 2n]), [0n, 0n]);
  assert.deepEqual(splitClosedSize(5n, []), []);
});

test("estimated liquidation price sits where equity meets maintenance", () => {
  // $500 at 5x: 1.25 ETH long at $2,000, MMF 3%. Maintenance = 0.03 x 1.25 x 2000 = $75.
  // Long: 2000 - (500 - 75) / 1.25 = 1660. Short: 2000 + 340 = 2340.
  const params = { value6: 500n * USD, size6: (125n * UNIT) / 100n, mark18: P(2000n), mmf: "0.03" };
  assert.equal(estLiquidationPrice({ side: "long", ...params }), P(1660n));
  assert.equal(estLiquidationPrice({ side: "short", ...params }), P(2340n));
  assert.equal(estLiquidationPrice({ side: "long", ...params, size6: 0n }), null);
  // Deep in profit a long can't be liquidated above zero.
  assert.equal(estLiquidationPrice({ side: "long", ...params, value6: 10_000n * USD }), 0n);
});

/**
 * PositionToken's accounting, re-implemented: NAV = (capital + size x (mark -
 * entry)) / supply for a long, and executeTrigger's proportional shrink.
 */
class TokenModel {
  constructor(
    public size6: bigint,
    public entry18: bigint,
    public capital6: bigint,
    public balances: Map<string, bigint>,
  ) {}

  supply(): bigint {
    return [...this.balances.values()].reduce((a, b) => a + b, 0n);
  }

  totalAssets(mark18: bigint): bigint {
    return this.capital6 + (this.size6 * (mark18 - this.entry18)) / PRICE_SCALE;
  }

  nav(mark18: bigint): bigint {
    return (this.totalAssets(mark18) * PRICE_SCALE) / this.supply();
  }

  executeTrigger(holder: string, closedSize6: bigint, mark18: bigint): bigint {
    const shares = this.balances.get(holder) ?? 0n;
    const supply = this.supply();
    const assets = (shares * this.nav(mark18)) / PRICE_SCALE;
    this.capital6 -= (this.capital6 * shares) / supply;
    this.size6 = closedSize6 >= this.size6 ? 0n : this.size6 - closedSize6;
    this.balances.set(holder, 0n);
    return assets;
  }
}

test("three holders, two triggered: one aggregate order, slices add up to the fill, the third keeps its NAV", () => {
  // 2.5 ETH long from $2,000 on $1,000: A 500, B 300, C 200 shares.
  const token = new TokenModel(
    (25n * UNIT) / 10n,
    P(2000n),
    1000n * USD,
    new Map([
      ["a", 500n * USD],
      ["b", 300n * USD],
      ["c", 200n * USD],
    ]),
  );
  const mark = P(1890n);
  const levels = new Map([
    ["a", effectiveLevels(undefined, defaults)], // defaults: SL 1,900 -> hit
    ["b", effectiveLevels({ stopLoss: "1950", takeProfit: null }, defaults)], // custom 1,950 -> hit
    ["c", effectiveLevels({ stopLoss: null, takeProfit: null }, defaults)], // cleared -> never
  ]);
  const triggered = [...levels].filter(([, l]) => {
    const hit = levelsHit("long", l, mark);
    return hit.slHit || hit.tpHit;
  });
  assert.deepEqual(
    triggered.map(([h]) => h),
    ["a", "b"],
  );

  // ONE reduce-only order for the combined proportional size, on a 0.01 step.
  const shares = triggered.map(([h]) => token.balances.get(h) as bigint);
  const exiting = shares.reduce((a, b) => a + b, 0n);
  const order6 = redeemClosedSize({
    shares: exiting,
    supply: token.supply(),
    size6: token.size6,
    legSize6: token.size6,
    mark18: mark,
    grid: { stepSize: "0.01", minOrderSize: "0.01", minOrderNotional: "10" },
  });
  assert.equal(order6, 2n * UNIT); // 800 / 1000 x 2.5

  const navBefore = token.nav(mark);
  const slices = splitClosedSize(order6, shares);
  assert.equal(slices.reduce((a, b) => a + b, 0n), order6);

  let paid = 0n;
  triggered.forEach(([h], i) => {
    paid += token.executeTrigger(h, slices[i], mark);
  });

  // Paid shares x NAV; C's NAV and the leverage are unchanged.
  assert.equal(paid, (exiting * navBefore) / PRICE_SCALE);
  assert.equal(token.nav(mark), navBefore);
  assert.equal(token.size6, (5n * UNIT) / 10n); // 2.5 - 2.0
  assert.equal(token.balances.get("c"), 200n * USD);

  // A default holder fired, so the defaults retire: a later buyer has none.
  const usedDefaults = triggered.some(([, l]) => l.usingDefault);
  assert.equal(usedDefaults, true);
  assert.deepEqual(effectiveLevels(undefined, { ...defaults, defaultsActive: !usedDefaults }), {
    stopLoss: 0n,
    takeProfit: 0n,
    usingDefault: true,
  });
});
