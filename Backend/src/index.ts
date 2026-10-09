import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";

import { connectDb, db } from "./config/db";
import { assertFaucetConfig, assertOrchestrationConfig, assertProtectionConfig, config } from "./config/env";
import { HttpError } from "./lib/errors";
import { createLogger, errorFields } from "./lib/logger";
import { startIndexer } from "./indexer";
import { adminRouter } from "./routes/admin";
import { faucetRouter } from "./routes/faucet";
import { healthRouter } from "./routes/health";
import { marketDataRouter } from "./routes/marketData";
import { marketsRouter } from "./routes/markets";
import { positionsRouter } from "./routes/positions";
import { protectionRouter } from "./routes/protection";
import { usersRouter } from "./routes/users";
import { verifySlotCredentials } from "./services/allocator";
import { startSettlementJob } from "./services/closePosition";
import { startFaucetMonitor } from "./services/faucet";
import { startLiquidationJob } from "./services/liquidator";
import { startMarketSync } from "./services/marketSync";
import { resumeOpenRequests } from "./services/openPosition";
import { startProtectionJob } from "./services/protection";
import { startReconciler } from "./services/reconciler";
import { onStreamLiquidationSignal, startReportingJob } from "./services/reporter";
import { statsRouter } from "./routes/stats";
import { POSITION_FORCED_EXIT_REASONS, PositionStatus } from "./venue/perpl/config";
import { closeAll as closeTradingSockets, onPosition, openForActiveSlots } from "./venue/perpl/connections";

const log = createLogger("server");

const app = express();
// req.ip from X-Forwarded-For, for the faucet's per-IP limit. See TRUST_PROXY.
app.set("trust proxy", config.trustProxy);
app.use(cors());
app.use(express.json());

app.use("/admin", adminRouter);
app.use("/faucet", faucetRouter);
app.use("/health", healthRouter);
app.use("/market-data", marketDataRouter);
app.use("/markets", marketsRouter);
app.use("/positions", positionsRouter);
app.use("/protection", protectionRouter);
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
  // Before anything reads the database: Neon may be waking from idle.
  await connectDb();

  // Public routes (discovery, position pages, charts) still work without
  // these, so warn rather than refuse to boot.
  if (!config.privyAppId || !config.privyAppSecret) {
    log.warn("PRIVY_APP_ID / PRIVY_APP_SECRET unset -- every authenticated route will fail");
  }

  if (config.enableIndexer || config.enableReconciler || config.enableReporter || config.enableLiquidator) {
    assertOrchestrationConfig();

    // A slot whose API key, account or forwarding flag is wrong fails on the
    // creator's first order and nowhere earlier; surfacing it at boot turns
    // that into a config error instead of a stuck position. Slots with a
    // problem are kept out of reserveSlot (and listed on /health).
    const problems = await verifySlotCredentials().catch((error) => {
      log.error("slot verification failed", errorFields(error));
      return [];
    });
    for (const problem of problems) {
      log.error("slot is not usable", { ...problem });
    }
  }

  // Testnet only. A missing key or a malformed amount refuses to boot rather
  // than failing a tester's first click.
  if (config.faucetEnabled) {
    assertFaucetConfig();
    stopWorkers.push(startFaucetMonitor());
  } else {
    log.info("test funds faucet is off (FAUCET_ENABLED != true)");
  }

  // Open-position requests are driven in this process; pick up any a restart
  // interrupted rather than waiting for the reconciler's first tick.
  if (config.enableReconciler) {
    void resumeOpenRequests().catch((error) => log.error("open-request resume at boot failed", errorFields(error)));
  }

  // Always on: GET /markets needs the table, and every order needs each
  // market's ids and decimals. Syncs once now, then every minute -- one public
  // Perpl call per tick.
  stopWorkers.push(startMarketSync());

  if (config.enableIndexer || config.enableReconciler || config.enableReporter) {
    // One Perpl trading socket per slot with something live on it. A position
    // the venue liquidated, deleveraged or unwound goes to the same idempotent
    // check the reporter's on-chain read uses as its fallback.
    onPosition((slotId, position) => {
      const forced =
        position.st === PositionStatus.Liquidated ||
        position.st === PositionStatus.Deleveraged ||
        position.st === PositionStatus.Unwound ||
        (position.sr !== undefined && POSITION_FORCED_EXIT_REASONS.has(position.sr));
      if (!forced) return;
      void onStreamLiquidationSignal(slotId, { venueMarketId: position.mkt, atMs: position.at?.t }).catch((error) =>
        log.error("stream liquidation check failed", { slotId, ...errorFields(error) }),
      );
    });
    void openForActiveSlots().catch((error) => log.error("opening trading sockets failed", errorFields(error)));
  }

  if (config.enableIndexer) stopWorkers.push(startIndexer());
  if (config.enableReconciler) {
    stopWorkers.push(startReconciler());
    stopWorkers.push(startSettlementJob());
  }
  if (config.enableReporter) stopWorkers.push(startReportingJob());
  if (config.enableLiquidator) stopWorkers.push(startLiquidationJob());
  // Loan protection (Spec 05): refuses to boot without the Privy signer rather than failing at the first repay.
  if (config.enableProtection) {
    assertProtectionConfig();
    stopWorkers.push(startProtectionJob());
  }

  const server = app.listen(config.port, () => {
    log.info(`Laxu backend listening on port ${config.port}`, {
      indexer: config.enableIndexer,
      reconciler: config.enableReconciler,
      reporter: config.enableReporter,
      liquidator: config.enableLiquidator,
      protection: config.enableProtection,
      faucet: config.faucetEnabled,
    });
  });

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    for (const stop of stopWorkers) stop();
    closeTradingSockets();
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
