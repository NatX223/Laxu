import { Router } from "express";

import { z } from "zod";

import { asyncHandler } from "../lib/async";
import { badRequest, notFound } from "../lib/errors";
import { fundingSummary } from "../services/funding";
import { findMarketByName, listMarkets, serialiseMarket } from "../services/markets";

export const marketsRouter = Router();

/// ONLINE markets, sorted by asset class then symbol. `?all=true` includes
/// OFFLINE ones.
marketsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const markets = await listMarkets({ all: req.query.all === "true" });
    res.json(markets.map(serialiseMarket));
  }),
);

const fundingQuery = z.object({ hours: z.coerce.number().int().min(1).max(24 * 30).default(24) });

/// Funding: the current rate (Perpl's newest funding event) and the last
/// `hours` of history, as percent per funding interval and annualised.
/// Positive: longs pay shorts. Cached 60 s.
marketsRouter.get(
  "/:symbol/funding",
  asyncHandler(async (req, res) => {
    const query = fundingQuery.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid query", "INVALID_REQUEST", query.error.issues);
    res.set("Cache-Control", "public, max-age=60");
    res.json(await fundingSummary(req.params.symbol, query.data.hours));
  }),
);

/// One market by display symbol ("ETH-USD") or base asset ("ETH"), any status.
marketsRouter.get(
  "/:symbol",
  asyncHandler(async (req, res) => {
    const market = await findMarketByName(req.params.symbol);
    if (!market) throw notFound(`Unknown market ${req.params.symbol}`, "UNKNOWN_MARKET");
    res.json(serialiseMarket(market));
  }),
);
