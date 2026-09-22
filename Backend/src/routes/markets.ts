import { Router } from "express";

import { asyncHandler } from "../lib/async";
import { bytes32ToSymbol, listMarkets, refreshMarkets } from "../services/markets";

export const marketsRouter = Router();

marketsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const markets = await listMarkets();
    res.json({
      markets: markets.map((market) => ({
        symbol: market.symbol,
        laxuMarket: market.laxuMarket,
        assetClass: market.assetClass,
        arcusMarketId: market.arcusMarketId,
        arcusDisplayName: market.arcusDisplayName,
        tickSize: market.tickSize,
        stepSize: market.stepSize,
        minOrderSize: market.minOrderSize,
        maxOrderSize: market.maxOrderSize,
        maxLeverage: market.maxLeverage,
        status: market.status,
        refreshedAt: market.refreshedAt?.toISOString() ?? null,
      })),
    });
  }),
);

/// Re-pull tick/step and ids from Arcus. Safe to call repeatedly; it is also run
/// at boot, so this exists for when a market goes live mid-session.
marketsRouter.post(
  "/refresh",
  asyncHandler(async (_req, res) => {
    res.json(await refreshMarkets());
  }),
);

export { bytes32ToSymbol };
