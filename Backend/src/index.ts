import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";

import { db } from "./config/db";
import { assertOrchestrationConfig, config } from "./config/env";
import { HttpError } from "./lib/errors";
import { createLogger, errorFields } from "./lib/logger";
import { startIndexer } from "./indexer";
import { healthRouter } from "./routes/health";
import { marketsRouter } from "./routes/markets";
import { positionsRouter } from "./routes/positions";
import { usersRouter } from "./routes/users";
import { verifySlotCredentials } from "./services/allocator";
import { startSettlementJob } from "./services/closePosition";
import { startLiquidationJob } from "./services/liquidator";
import { closeArcusStream, getArcusStream, startArcusStream } from "./services/arcusStream";
import { startMarketSync } from "./services/marketSync";
import { resumeOpenRequests } from "./services/openPosition";
import { startReconciler } from "./services/reconciler";
import { onStreamLiquidationSignal, startReportingJob } from "./services/reporter";
import { statsRouter } from "./routes/stats";

const log = createLogger("server");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/health", healthRouter);
app.use("/markets", marketsRouter);
app.use("/positions", positionsRouter);
app.use("/stats", statsRouter);
app.use("/users", usersRouter);

app.use((_req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "No such route" } });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    res
      .status(error.status)
      .json({ error: { code: error.code, message: error.message, details: error.details } });
    return;
  }
  log.error("unhandled error", errorFields(error));
  res.status(500).json({ error: { code: "INTERNAL", message: "Internal server error" } });
});

const stopWorkers: Array<() => void> = [];

async function start(): Promise<void> {
  // Public routes (discovery, position pages, charts) still work without
  // these, so warn rather than refuse to boot.
  if (!config.privyAppId || !config.privyAppSecret) {
    log.warn("PRIVY_APP_ID / PRIVY_APP_SECRET unset -- every authenticated route will fail");
  }

  if (config.enableIndexer || config.enableReconciler || config.enableReporter || config.enableLiquidator) {
    assertOrchestrationConfig();

    // A slot whose stored public key does not match its secret fails with a 401
    // on the first order and nowhere earlier; surfacing it at boot turns that
    // into a config error instead of a stuck position.
    const problems = await verifySlotCredentials();
    for (const problem of problems) {
      log.error("slot credentials are inconsistent", problem);
    }
  }

  // Open-position requests are driven in this process; pick up any a restart
  // interrupted rather than waiting for the reconciler's first tick.
  if (config.enableReconciler) {
    void resumeOpenRequests().catch((error) => log.error("open-request resume at boot failed", errorFields(error)));
  }

  // Always on: GET /markets needs the table, and the open flow needs each
  // market's tickSize/stepSize to sign an order. Syncs once now, then every
  // minute -- one public Arcus call per tick.
  stopWorkers.push(startMarketSync());

  if (config.enableIndexer || config.enableReconciler || config.enableReporter) {
    // One shared Arcus stream for every slot: fills, positions and transfers.
    // Liquidation-marked fills and unexpected FLAT rows go to the same
    // idempotent check the reporter uses as its fallback.
    const stream = getArcusStream();
    stream.onLiquidationFill((account, fill) => {
      void onStreamLiquidationSignal(account, { marketId: fill.marketId, fill });
    });
    // A FLAT row can also be a creator close landing; checkForLiquidation
    // ignores it then (a close is in progress).
    stream.onPositionFlat((account, row) => {
      void onStreamLiquidationSignal(account, { marketId: row.marketId });
    });
    stopWorkers.push(startArcusStream());
  }

  if (config.enableIndexer) stopWorkers.push(startIndexer());
  if (config.enableReconciler) {
    stopWorkers.push(startReconciler());
    stopWorkers.push(startSettlementJob());
  }
  if (config.enableReporter) stopWorkers.push(startReportingJob());
  if (config.enableLiquidator) stopWorkers.push(startLiquidationJob());

  const server = app.listen(config.port, () => {
    log.info(`Laxu backend listening on port ${config.port}`, {
      indexer: config.enableIndexer,
      reconciler: config.enableReconciler,
      reporter: config.enableReporter,
      liquidator: config.enableLiquidator,
    });
  });

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    for (const stop of stopWorkers) stop();
    closeArcusStream();
    server.close();
    await db.$disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

start().catch((error) => {
  log.error("failed to start", errorFields(error));
  process.exit(1);
});

export { app };
