import { Prisma, PrismaClient } from "@prisma/client";

import { createLogger } from "../lib/logger";

const log = createLogger("db");

/// Interactive transactions make several round-trips each; to Neon (a remote
/// region) Prisma's 5 s default expired a mint's bookkeeping transaction on
/// testnet. 30 s keeps them atomic without being cut short.
export const db = new PrismaClient({ transactionOptions: { maxWait: 10_000, timeout: 30_000 } });

/// Slot allocation and any other read-modify-write on shared rows goes through
/// db.$transaction(...) -- see src/services/allocator.ts, which additionally
/// takes a row lock, because a transaction alone does not stop two concurrent
/// open-position requests from reading the same `free` slot.
export type Db = typeof db;

// ---------------------------------------------------------------------------
// Neon cold starts. The database suspends when idle, and the first connection
// after that fails with "Can't reach database server" (P1001) for a few
// seconds (docs/perpl-findings.md#f-neon). A query that failed to CONNECT never
// reached the server, so retrying it -- even a write -- cannot apply it twice.
// ---------------------------------------------------------------------------

const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000];
const CONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

/// The connection could not be made at all (nothing was executed).
export function isConnectError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P1001") return true;
  return /can't reach database server/i.test(error instanceof Error ? error.message : String(error));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/// Every query outside an interactive transaction retries a connect failure
/// with backoff. Inside one, the transaction itself is gone -- the caller's
/// retry (a worker's next tick) starts it again.
db.$use(async (params, next) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await next(params);
    } catch (error) {
      if (params.runInTransaction || attempt >= RETRY_DELAYS_MS.length || !isConnectError(error)) throw error;
      log.warn("database unreachable; retrying", {
        model: params.model,
        action: params.action,
        attempt: attempt + 1,
        delayMs: RETRY_DELAYS_MS[attempt],
      });
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
});

/// Boot: connect with backoff (a suspended Neon compute takes seconds to wake).
export async function connectDb(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await db.$connect();
      await db.$queryRaw`SELECT 1`;
      if (attempt > 0) log.info("database reachable", { attempts: attempt + 1 });
      return;
    } catch (error) {
      if (attempt >= CONNECT_DELAYS_MS.length || !isConnectError(error)) throw error;
      log.warn("database not reachable yet; retrying", { attempt: attempt + 1, delayMs: CONNECT_DELAYS_MS[attempt] });
      await db.$disconnect().catch(() => undefined);
      await sleep(CONNECT_DELAYS_MS[attempt]);
    }
  }
}
