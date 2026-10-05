import type { Prisma } from "@prisma/client";

import { db } from "../config/db";
import type { SentRequest } from "./types";

/**
 * Request-id bookkeeping shared by every flow that sends an order. The rule
 * (same as the old client-id rule): the `rq`, `lb` and pre-send size are saved on the flow's
 * own row BEFORE the order is sent, and the slot's `lastRequestId` is raised
 * in the same transaction -- so a restart can always look its own order up,
 * and never hands the same `rq` to a different order.
 */

/// The next `rq`: strictly above everything this account has seen -- the
/// exchange's `lfr`, the slot's saved counter, and what this process handed
/// out (Perpl rejects `rq <= lfr` with sr:32).
export function nextRequestId(params: { lfr: bigint; lastRequestId: bigint; handedOut: bigint }): bigint {
  const { lfr, lastRequestId, handedOut } = params;
  const max = [lfr, lastRequestId, handedOut].reduce((a, b) => (b > a ? b : a));
  return max + 1n;
}

/// `lb` = head + the market's order_ttl_blocks (at least 1): the docs' ceiling.
export function lastExecBlockFor(head: bigint, orderTtlBlocks: number): bigint {
  return head + BigInt(Math.max(1, orderTtlBlocks));
}

export type LotDecision =
  | "pending"
  | "not_placed"
  | { filledSize6: bigint; avgPrice18: bigint; grew: boolean };

/**
 * The lot rule (docs/perpl-findings.md#v-adapter-216): an order with no socket
 * verdict is decided on-chain once the chain is PAST its `lb` -- no order can
 * execute after it. Changed size -> filled by the delta (price: the weighted
 * entry for an add, the mark for a reduce); unchanged -> never placed.
 */
export function decideByLots(params: {
  chainBlock: bigint;
  lastExecBlock: bigint;
  size6Before: bigint;
  entry18Before: bigint;
  size6Now: bigint;
  entry18Now: bigint;
  mark18Now: bigint;
}): LotDecision {
  const { chainBlock, lastExecBlock, size6Before, entry18Before, size6Now, entry18Now, mark18Now } = params;
  if (chainBlock <= lastExecBlock) return "pending";
  const grew = size6Now > size6Before;
  const delta = grew ? size6Now - size6Before : size6Before - size6Now;
  if (delta === 0n) return "not_placed";
  const avgPrice18 = grew ? (entry18Now * size6Now - entry18Before * size6Before) / delta : mark18Now;
  return { filledSize6: delta, avgPrice18, grew };
}

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

/// Save an order's `rq` / `lb` and the on-chain size/entry before it on a
/// ledger row, and raise the slot's counter, atomically.
export async function saveLedgerRequest(entryId: string, slotId: string, request: SentRequest): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.ledgerEntry.update({
      where: { id: entryId },
      data: {
        venueRequestId: request.requestId.toString(),
        venueLastExecBlock: request.lastExecBlock.toString(),
        venueSizeBefore: request.size6Before.toString(),
        venueEntryBefore: request.entry18Before.toString(),
      },
    });
    await raiseLastRequestId(tx, slotId, request.requestId);
  });
}
