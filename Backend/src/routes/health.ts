import { Router } from "express";

import { db } from "../config/db";
import { config } from "../config/env";
import { asyncHandler } from "../lib/async";
import { fromAsset6 } from "../lib/units";
import { connectionStates } from "../venue/perpl/connections";
import { currentSlotProblems, poolStats } from "../services/allocator";
import { faucetAssetBalance, faucetBalance } from "../services/faucet";
import { floatBalance } from "../services/float";
import { fundingAges } from "../services/reporter";

export const healthRouter = Router();

/// Never lets one failed read take the whole answer down.
async function safely<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/// Liveness plus slot pool counts -- the trade screen reads `slots.free` to
/// say "all slots busy" before the user pays. A database hiccup still answers
/// 200 with `slots: null` so liveness never depends on Postgres.
healthRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const slots = await poolStats().catch(() => null);
    res.json({ status: "ok", slots });
  }),
);

/// Deeper check for a load balancer or an on-call glance: does the database
/// answer, is there anywhere left to put a new position, and is the money and
/// venue plumbing healthy.
healthRouter.get(
  "/ready",
  asyncHandler(async (_req, res) => {
    const checks: Record<string, unknown> = {
      indexer: config.enableIndexer,
      reconciler: config.enableReconciler,
      reporter: config.enableReporter,
    };

    try {
      await db.$queryRaw`SELECT 1`;
      checks.database = "ok";
    } catch (error) {
      checks.database = error instanceof Error ? error.message : "unreachable";
      res.status(503).json({ status: "degraded", checks });
      return;
    }

    const slots = await poolStats();
    checks.slots = slots;
    checks.slotProblems = currentSlotProblems();

    const [float, faucetNative, faucetAsset, ages] = await Promise.all([
      config.floatPrivateKey && config.assetAddress ? safely(floatBalance) : Promise.resolve(null),
      config.faucetEnabled ? safely(faucetBalance) : Promise.resolve(null),
      config.faucetEnabled ? safely(faucetAssetBalance) : Promise.resolve(null),
      config.positionTokenFactoryAddress ? safely(fundingAges) : Promise.resolve(null),
    ]);
    checks.float = float === null ? null : fromAsset6(float);
    checks.faucet = config.faucetEnabled
      ? {
          nativeWei: faucetNative?.toString() ?? null,
          asset: faucetAsset === null ? null : fromAsset6(faucetAsset),
        }
      : null;
    checks.tradingSockets = connectionStates();
    /// Seconds since each open position's last applyFunding. Past 7200
    /// (FUNDING_MAX_AGE) the token stops reporting a fresh price and borrowing pauses.
    checks.fundingAgeSeconds = ages;

    const ready = slots.free > 0;
    res.status(ready ? 200 : 503).json({
      status: ready ? "ok" : "no-free-slots",
      checks,
    });
  }),
);
