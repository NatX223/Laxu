import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";

import { config } from "../config/env";
import { asyncHandler } from "../lib/async";
import { forbidden, unauthorized } from "../lib/errors";
import { faucetSummary } from "../services/faucet";

export const adminRouter = Router();

const digest = (value: string) => createHash("sha256").update(value).digest();

/// `x-admin-token: <ADMIN_TOKEN>`. Hashing both sides first gives
/// timingSafeEqual equal-length inputs whatever was sent.
function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!config.adminToken) {
    next(forbidden("Admin routes are off (ADMIN_TOKEN unset)", "ADMIN_DISABLED"));
    return;
  }
  const sent = req.header("x-admin-token") ?? "";
  if (!timingSafeEqual(digest(sent), digest(config.adminToken))) {
    next(unauthorized("Bad or missing x-admin-token", "ADMIN_UNAUTHORIZED"));
    return;
  }
  next();
}

adminRouter.use(requireAdmin);

/// Faucet balance, claims in the last 24h and the last 10 failures.
adminRouter.get(
  "/faucet",
  asyncHandler(async (_req, res) => {
    res.json(await faucetSummary());
  }),
);
