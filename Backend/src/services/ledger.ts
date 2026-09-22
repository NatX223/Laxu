import type { LedgerEntry } from "@prisma/client";

import { db } from "../config/db";
import { createLogger } from "../lib/logger";

const log = createLogger("ledger");

export type LedgerType = "deposit" | "margin_add" | "margin_remove" | "close";
export type ArcusStatus = "pending" | "confirmed" | "reversed";

/**
 * The ordering rule the whole recovery story rests on:
 *
 *   1. write the entry as `pending`
 *   2. call Arcus
 *   3. flip to `confirmed` only once Arcus confirms
 *
 * A crash between 1 and 3 leaves a `pending` row naming exactly what was in
 * flight, so the reconciler can ask Arcus what actually happened instead of
 * guessing. Writing the row after the call would lose that.
 */
export async function recordPending(params: {
  positionId: string;
  type: LedgerType;
  /// USDG base units, as a string.
  amount: string;
  onchainRequestId?: string;
  controller?: string;
  note?: string;
}): Promise<LedgerEntry> {
  const entry = await db.ledgerEntry.create({
    data: {
      positionId: params.positionId,
      type: params.type,
      amount: params.amount,
      arcusStatus: "pending",
      onchainRequestId: params.onchainRequestId,
      controller: params.controller?.toLowerCase(),
      note: params.note,
    },
  });
  log.info("ledger pending", { id: entry.id, type: entry.type, amount: entry.amount });
  return entry;
}

export async function markConfirmed(
  id: string,
  extra: { arcusRequestId?: string; note?: string } = {},
): Promise<LedgerEntry> {
  const entry = await db.ledgerEntry.update({
    where: { id },
    data: { arcusStatus: "confirmed", ...extra },
  });
  log.info("ledger confirmed", { id, type: entry.type, amount: entry.amount });
  return entry;
}

export async function markReversed(id: string, note: string): Promise<LedgerEntry> {
  const entry = await db.ledgerEntry.update({
    where: { id },
    data: { arcusStatus: "reversed", note },
  });
  log.warn("ledger reversed", { id, type: entry.type, amount: entry.amount, note });
  return entry;
}

/// Set once the matching on-chain fulfill call lands. What distinguishes a
/// finished entry from one confirmed on Arcus but stranded before the chain leg.
export async function markOnchainFulfilled(id: string): Promise<LedgerEntry> {
  return db.ledgerEntry.update({
    where: { id },
    data: { onchainFulfilledAt: new Date() },
  });
}

export async function findEntryForRequest(params: {
  positionId: string;
  type: LedgerType;
  onchainRequestId: string;
  controller: string;
}): Promise<LedgerEntry | null> {
  return db.ledgerEntry.findFirst({
    where: {
      positionId: params.positionId,
      type: params.type,
      onchainRequestId: params.onchainRequestId,
      controller: params.controller.toLowerCase(),
    },
    orderBy: { createdAt: "desc" },
  });
}

/// Net confirmed collateral for a position, in USDG base units. Deposits and
/// margin adds credit; margin removes and the close debit. Reversed entries are
/// excluded by construction -- they never happened.
export async function expectedMargin(positionId: string): Promise<bigint> {
  const entries = await db.ledgerEntry.findMany({
    where: { positionId, arcusStatus: "confirmed" },
    select: { type: true, amount: true },
  });

  let total = 0n;
  for (const entry of entries) {
    const amount = BigInt(entry.amount);
    if (entry.type === "deposit" || entry.type === "margin_add") total += amount;
    else total -= amount;
  }
  return total;
}
