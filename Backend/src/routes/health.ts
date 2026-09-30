import { Router } from "express";

import { db } from "../config/db";
import { config } from "../config/env";
import { asyncHandler } from "../lib/async";
import { poolStats } from "../services/allocator";

export const healthRouter = Router();

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
/// answer, and is there anywhere left to put a new position?
healthRouter.get(
  "/ready",
  asyncHandler(async (_req, res) => {
    const checks: Record<string, unknown> = {
      indexer: config.enableIndexer,
      reconciler: config.enableReconciler,
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

    const ready = slots.free > 0;
    res.status(ready ? 200 : 503).json({
      status: ready ? "ok" : "no-free-slots",
      checks,
    });
  }),
);
