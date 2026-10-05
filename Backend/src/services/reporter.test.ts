import assert from "node:assert/strict";
import test from "node:test";

import { fundingTarget, shouldPushFunding } from "./reporter";

const E18 = 10n ** 18n;

test("funding: computeFundingTarget equals venue total minus capital minus price PnL plus settled", () => {
  // The recorded slot-1 position after the funding event (docs/perpl-findings.md#v-adapter-277):
  // depositCNS 23809490 + pnlCNS 103880 (= delta 104580 + premium -700), 0.014 ETH from 2687.07.
  const terms = {
    positionEquity: 23_809_490n + 103_880n,
    free: 100_000_000n + 2_500_000n, // reserve + $2.50 left over from a buy-in
    reserve: 100_000_000n,
    capital: 23_809_490n,
    size: 14_000n,
    entryPrice: 268707n * 10n ** 16n,
    mark: 269454n * 10n ** 16n,
    direction: "long",
    fundingSettled: 0n,
  };
  const out = fundingTarget(terms);
  assert.equal(out.freeAboveReserve, 2_500_000n);
  assert.equal(out.venueTotal, 23_913_370n + 2_500_000n);
  assert.equal(out.pricePnL, (14_000n * (269454n - 268707n) * 10n ** 16n) / E18, "size x (mark - entry) / 1e18");
  assert.equal(out.pricePnL, 104_580n, "= deltaPnlCNS");
  assert.equal(out.target, out.venueTotal - terms.capital - out.pricePnL + terms.fundingSettled);
  // What is left is the funding the long paid (-700) plus the free balance.
  assert.equal(out.target, -700n + 2_500_000n);

  // A short negates the price PnL; fundingSettled adds back.
  const short = fundingTarget({ ...terms, direction: "short", fundingSettled: 1_000n });
  assert.equal(short.pricePnL, -104_580n);
  assert.equal(short.target, short.venueTotal - terms.capital + 104_580n + 1_000n);
  // Free balance below the reserve never counts negative.
  assert.equal(fundingTarget({ ...terms, free: 10n }).freeAboveReserve, 0n);
});

test("funding: a push happens on threshold or heartbeat, not otherwise", () => {
  // FUNDING_PUSH_MIN 100000 ($0.10), FUNDING_PUSH_BPS 10, FUNDING_HEARTBEAT_SECONDS 1800 (.env).
  const at = (target: bigint, ageSeconds: bigint, capital = 50_000_000n) =>
    shouldPushFunding({ target, accrued: 0n, capital, pushMin: 100_000n, pushBps: 10, ageSeconds, heartbeatSeconds: 1800 });
  assert.equal(at(99_999n, 60n), false, "below max($0.10, 0.1% of $50) and fresh: no push");
  assert.equal(at(100_000n, 60n), true, "moved by the absolute minimum");
  assert.equal(at(-100_000n, 60n), true, "a move down counts too");
  assert.equal(at(0n, 1800n), true, "heartbeat: nothing moved but the last push is 30 min old");
  assert.equal(at(0n, 1799n), false);
  // With $500 capital the relative threshold (0.1% = $0.50) is the larger one.
  assert.equal(at(400_000n, 60n, 500_000_000n), false);
  assert.equal(at(500_000n, 60n, 500_000_000n), true);
});
