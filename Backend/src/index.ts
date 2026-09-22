import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";

import { closeArcusStream } from "./arcus/ws";
import { db } from "./config/db";
import { assertOrchestrationConfig, config } from "./config/env";
import { HttpError } from "./lib/errors";
import { createLogger, errorFields } from "./lib/logger";
import { startIndexer } from "./indexer";
import { authRouter } from "./routes/auth";
import { healthRouter } from "./routes/health";
import { marketsRouter } from "./routes/markets";
import { positionsRouter } from "./routes/positions";
import { usersRouter } from "./routes/users";
import { verifySlotCredentials } from "./services/allocator";
import { refreshMarkets } from "./services/markets";
import { startReconciler } from "./services/reconciler";

const log = createLogger("server");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/health", healthRouter);
app.use("/auth", authRouter);
app.use("/markets", marketsRouter);
app.use("/positions", positionsRouter);
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
  if (config.enableIndexer || config.enableReconciler) {
    assertOrchestrationConfig();

    // A slot whose stored public key does not match its secret fails with a 401
    // on the first order and nowhere earlier; surfacing it at boot turns that
    // into a config error instead of a stuck position.
    const problems = await verifySlotCredentials();
    for (const problem of problems) {
      log.error("slot credentials are inconsistent", problem);
    }

    // Order signing needs each market's tickSize and stepSize, so this is not
    // optional warm-up -- an unresolved market cannot be traded at all.
    try {
      const result = await refreshMarkets();
      if (result.unresolved.length > 0) {
        log.warn("markets without an Arcus counterpart will reject orders", {
          symbols: result.unresolved,
        });
      }
    } catch (error) {
      log.error("market refresh at boot failed", errorFields(error));
    }
  }

  if (config.enableIndexer) stopWorkers.push(startIndexer());
  if (config.enableReconciler) stopWorkers.push(startReconciler());

  const server = app.listen(config.port, () => {
    log.info(`Laxu backend listening on port ${config.port}`, {
      indexer: config.enableIndexer,
      reconciler: config.enableReconciler,
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
