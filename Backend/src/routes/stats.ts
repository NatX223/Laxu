import { Router } from "express";

import { asyncHandler } from "../lib/async";
import { globalStats } from "../services/discovery";

export const statsRouter = Router();

/// Global stats bar, over listed positions. Cached in memory for 60s.
statsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await globalStats());
  }),
);
