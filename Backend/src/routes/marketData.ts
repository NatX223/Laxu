import { Router } from "express";

import { asyncHandler } from "../lib/async";
import { badRequest } from "../lib/errors";
import { proxyPublic, recentTrades } from "../services/marketData";

export const marketDataRouter = Router();

/// Recent trades for one market, newest first -- from the backend's own market-data
/// socket, since Perpl has no REST endpoint for them. Declared before the
/// catch-all below. Prices and sizes are Perpl's scaled integers.
marketDataRouter.get(
  "/v1/market-data/:id/trades",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || id > 999_999) throw badRequest("Invalid market id", "INVALID_MARKET");
    res.set("Cache-Control", "public, max-age=1");
    res.json({ d: await recentTrades(id) });
  }),
);

/// Allowlisted, cached passthrough of Perpl's public REST. `/market-data/v1/<path>`
/// here is `<perplApiUrl>/v1/<path>` there, so the App swaps one base URL and
/// keeps every path.
marketDataRouter.get(
  /^\/v1\/(.+)$/,
  asyncHandler(async (req, res) => {
    const { status, body, maxAge } = await proxyPublic((req.params as unknown as string[])[0]);
    if (maxAge > 0) res.set("Cache-Control", `public, max-age=${maxAge}`);
    res.status(status).json(body);
  }),
);
