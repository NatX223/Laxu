import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { ApiContext } from "../venue/perpl/types";
import { maxLeverage } from "./markets";
import { toMarketData } from "./marketSync";

/// GET /v1/pub/context recorded on Monad testnet 2026-10-05.
const context = JSON.parse(
  readFileSync(join(process.cwd(), "fixtures", "perpl", "context.testnet.json"), "utf8"),
) as ApiContext;

test("marketSync: recorded context maps to markets with perpetualId, decimals and capped leverage", () => {
  const rows = new Map(context.markets.map((m) => [m.symbol, toMarketData(m)]));
  const eth = rows.get("ETH")!;
  assert.equal(eth.venueMarketId, 32);
  assert.equal(eth.perpetualId, 32);
  assert.equal(eth.displaySymbol, "ETH-USD");
  assert.equal(eth.priceDecimals, 2);
  assert.equal(eth.sizeDecimals, 3);
  assert.equal(eth.orderTtlBlocks, 20);
  assert.equal(eth.takerFeeMicros, 345);
  assert.equal(eth.tickSize, "0.01");
  assert.equal(eth.stepSize, "0.001");
  assert.equal(eth.status, "ONLINE");

  // Max leverage = initial_margin / 100, capped at 20 (docs/perpl-findings.md#v-units-171).
  const limit = (symbol: string) => maxLeverage({ initialMarginFraction: rows.get(symbol)!.initialMarginFraction as string });
  assert.equal(limit("ETH"), 12);
  assert.equal(limit("BTC"), 15);
  assert.equal(limit("SOL"), 10);
  assert.equal(limit("MON"), 3);
  assert.equal(limit("PUMP"), 5);
  for (const m of context.markets) {
    const lev = limit(m.symbol);
    assert.ok(lev >= 1 && lev <= 20, `${m.symbol} ${lev}x within 1..20`);
    assert.equal(lev, Math.min(20, Math.floor(m.config.initial_margin / 100)), `${m.symbol}`);
  }
});
