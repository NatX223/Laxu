import assert from "node:assert/strict";
import test from "node:test";

import type { ApiFundingEvent } from "../venue/perpl/types";
import {
  annualizedPct,
  chunkRange,
  dedupeByFeb,
  MAX_INTERVALS_PER_REQUEST,
  ratePct,
  toFundingPoint,
  whoPays,
} from "./fundingMath";

// GET /v1/market-data/16/funding/... on testnet, 2026-10-09 (BTC, price_decimals 1,
// funding_interval_sec 2580).
const BTC: ApiFundingEvent[] = [
  { at: { b: 69442242, t: 1791519219000 }, feb: 69442242, rate: 40, idx: 824448, ppl: 32, sum: 123842, div: 1 },
  { at: { b: 69450813, t: 1791521831000 }, feb: 69450813, rate: 40, idx: 822327, ppl: 32, sum: 123874, div: 1 },
  { at: { b: 69459384, t: 1791524447000 }, feb: 69459384, rate: 20, idx: 824205, ppl: 16, sum: 123890, div: 1 },
  { at: { b: 69467955, t: 1791527062000 }, feb: 69467955, rate: 10, idx: 823792, ppl: 8, sum: 123898, div: 1 },
];

test("funding: rate is micros per interval -- payment per lot matches idx x rate / 10^6", () => {
  // The check that settled the unit (the App had read it as per-100k, 10x too high).
  for (const e of BTC) assert.equal(Math.floor((e.idx * e.rate) / 1e6), e.ppl);
  assert.equal(ratePct(10), 0.001);
  assert.equal(ratePct(-25), -0.0025);
});

test("funding: annualised is simple: percent x intervals per year", () => {
  // 2580 s intervals: 12223.26 a year.
  assert.ok(Math.abs(annualizedPct(10, 2580) - 12.223) < 0.001);
  assert.ok(Math.abs(annualizedPct(100, 3600) - 87.6) < 1e-9);
  assert.equal(annualizedPct(10, 0), 0);
});

test("funding: a point carries percent, annualised, index price and an estimated flag", () => {
  const point = toFundingPoint(BTC[3], 2580, 1, BTC[3].at.t! - 1);
  assert.equal(point.ratePct, 0.001);
  assert.equal(point.indexPrice, 82379.2);
  assert.equal(point.block, 69467955);
  assert.equal(point.estimatedTime, true, "applies in the future: Perpl's time is an estimate");
  assert.equal(toFundingPoint(BTC[3], 2580, 1, BTC[3].at.t! + 1).estimatedTime, false);
});

test("funding: a repeated feb is the same interval republished; the later copy wins", () => {
  const exact = { ...BTC[3], at: { b: 69467955, t: 1791527063500 } };
  const out = dedupeByFeb([BTC[2], BTC[3], BTC[0], exact, BTC[1]]);
  assert.deepEqual(out.map((e) => e.feb), [69442242, 69450813, 69459384, 69467955]);
  assert.equal(out[3].at.t, 1791527063500);
});

test("funding: ranges beyond the per-request cap are split without gaps or overlap", () => {
  const sec = 2580;
  const span = MAX_INTERVALS_PER_REQUEST * sec * 1000;
  assert.deepEqual(chunkRange(0, 1000, sec), [[0, 1000]]);
  const chunks = chunkRange(0, span * 2.5, sec);
  assert.equal(chunks.length, 3);
  for (const [from, to] of chunks) assert.ok(to - from <= span);
  for (let i = 1; i < chunks.length; i += 1) assert.equal(chunks[i][0], chunks[i - 1][1] + 1);
  assert.equal(chunks[chunks.length - 1][1], span * 2.5);
});

test("funding: who pays, in words (exchange/funding.md)", () => {
  assert.equal(whoPays(10), "longs pay shorts");
  assert.equal(whoPays(-3), "shorts pay longs");
  assert.equal(whoPays(0), "no funding");
});
