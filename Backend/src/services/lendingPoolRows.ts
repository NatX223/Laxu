import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Record a lending pool row, atomically and idempotently. Three writers race
 * for the same row -- the mint's bookkeeping transaction, the minute retry
 * for missing pools, and the indexer's PoolCreated handler -- and Prisma's
 * upsert (select, then insert) lost that race on testnet 2026-10-05: the
 * unique violation aborted a whole mint transaction. ON CONFLICT never raises,
 * so it is also safe inside a transaction (where any failed statement aborts it).
 */
export async function recordLendingPoolRow(
  client: Prisma.TransactionClient | PrismaClient,
  pool: string,
  positionToken: string,
): Promise<void> {
  await client.$executeRaw`
    INSERT INTO lending_pools (id, pool_address, position_token_address)
    VALUES (${randomUUID()}, ${pool.toLowerCase()}, ${positionToken.toLowerCase()})
    ON CONFLICT (pool_address) DO NOTHING
  `;
}
