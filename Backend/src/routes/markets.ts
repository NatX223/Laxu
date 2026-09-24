import { Router } from "express";

import { asyncHandler } from "../lib/async";
import { notFound } from "../lib/errors";
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

/// One market by display symbol ("ETH-USD") or base asset ("ETH"), any status.
marketsRouter.get(
  "/:symbol",
  asyncHandler(async (req, res) => {
    const market = await findMarketByName(req.params.symbol);
    if (!market) throw notFound(`Unknown market ${req.params.symbol}`, "UNKNOWN_MARKET");
    res.json(serialiseMarket(market));
  }),
);
