import type { Prisma } from "@prisma/client";

import { db } from "../config/db";

/**
 * Request-id bookkeeping shared by every flow that sends an order. The rule
 * (same as the old client-id rule): the `rq` and `lb` are saved on the flow's
 * own row BEFORE the order is sent, and the slot's `lastRequestId` is raised
 * in the same transaction -- so a restart can always look its own order up,
 * and never hands the same `rq` to a different order.
 */

/// Raise `subaccount_slots.last_request_id` to at least `requestId`. Numeric
/// comparison in SQL: the column is a bigint stored as text, and concurrent
/// writers must never move it backwards.
export async function raiseLastRequestId(
  tx: Prisma.TransactionClient,
  slotId: string,
  requestId: bigint,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE subaccount_slots
    SET last_request_id = GREATEST(last_request_id::numeric, ${requestId.toString()}::numeric)::text
    WHERE id = ${slotId}
  `;
}

/// Save an order's `rq` / `lb` on a ledger row and raise the slot's counter, atomically.
export async function saveLedgerRequest(
  entryId: string,
  slotId: string,
  request: { requestId: bigint; lastExecBlock: bigint },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.ledgerEntry.update({
      where: { id: entryId },
      data: {
        venueRequestId: request.requestId.toString(),
        venueLastExecBlock: request.lastExecBlock.toString(),
      },
    });
    await raiseLastRequestId(tx, slotId, request.requestId);
  });
}
