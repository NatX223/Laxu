import type { OperatorWallet, SubaccountSlot } from "@prisma/client";

import { db } from "../config/db";
import { config } from "../config/env";
import { resolveSecret } from "../config/secrets";
import { publicKeyHex, loadEd25519PrivateKey } from "../arcus/ed25519";
import type { ArcusCredentials } from "../arcus/types";
import { conflict } from "../lib/errors";
import { createLogger } from "../lib/logger";

const log = createLogger("allocator");

export type SlotWithWallet = SubaccountSlot & { operatorWallet: OperatorWallet };

/**
 * Slot lifecycle:
 *
 *   free -> reserved   (user has been told where to send funds)
 *        -> allocated  (deposit confirmed, position live)
 *        -> free       (position closed, collateral swept, slot recycled)
 *
 * The same slot serves a different user on every cycle, so nothing user-specific
 * may survive the return to `free`.
 */

/// Release reservations that timed out without a deposit. Runs before every
/// allocation attempt so an abandoned reservation cannot starve the pool, and
/// again on the reconciliation tick for slots nobody is currently contending.
export async function reclaimExpiredReservations(): Promise<number> {
  const now = new Date();
  const expired = await db.subaccountSlot.findMany({
    where: { status: "reserved", reservationExpiresAt: { lt: now } },
    select: { id: true, positionId: true },
  });
  if (expired.length === 0) return 0;

  for (const slot of expired) {
    await db.$transaction(async (tx) => {
      await tx.subaccountSlot.update({
        where: { id: slot.id },
        data: {
          status: "free",
          reservedForUser: null,
          reservedAt: null,
          reservationExpiresAt: null,
          positionId: null,
        },
      });
      if (slot.positionId) {
        await tx.position.updateMany({
          where: { id: slot.positionId, status: "pending" },
          data: {
            status: "failed",
            failureReason: "Deposit not detected before the reservation timed out",
          },
        });
      }
    });
    log.warn("reservation expired, slot released", { slotId: slot.id, positionId: slot.positionId });
  }

  return expired.length;
}

/**
 * Claim a free slot for a user, atomically.
 *
 * `SELECT ... FOR UPDATE SKIP LOCKED` inside the transaction is the part that
 * matters: a transaction on its own does not stop two concurrent open-position
 * requests from reading the same `free` row under Postgres' default READ
 * COMMITTED isolation and both believing they won it. The row lock serialises
 * the claim, and SKIP LOCKED lets a second request move straight to the next
 * free slot instead of blocking behind the first.
 */
export async function reserveSlot(params: {
  userWalletAddress: string;
  positionId: string;
}): Promise<SlotWithWallet> {
  await reclaimExpiredReservations();

  const expiresAt = new Date(Date.now() + config.reservationTimeoutMs);

  const slotId = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT s.id
      FROM subaccount_slots s
      JOIN operator_wallets w ON w.id = s.operator_wallet_id
      WHERE s.status = 'free' AND w.status = 'active'
      ORDER BY s.updated_at ASC
      LIMIT 1
      FOR UPDATE OF s SKIP LOCKED
    `;

    const row = rows[0];
    if (!row) return undefined;

    await tx.subaccountSlot.update({
      where: { id: row.id },
      data: {
        status: "reserved",
        reservedForUser: params.userWalletAddress.toLowerCase(),
        reservedAt: new Date(),
        reservationExpiresAt: expiresAt,
        positionId: params.positionId,
      },
    });

    return row.id;
  });

  if (!slotId) {
    throw conflict(
      "No free subaccount slot is available. Every slot in the operator pool is in use.",
      "NO_FREE_SLOT",
    );
  }

  const slot = await getSlot(slotId);
  log.info("slot reserved", {
    slotId,
    accountIndex: slot.accountIndex,
    operatorWallet: slot.operatorWallet.address,
    positionId: params.positionId,
    expiresAt: expiresAt.toISOString(),
  });
  return slot;
}

export async function getSlot(slotId: string): Promise<SlotWithWallet> {
  const slot = await db.subaccountSlot.findUnique({
    where: { id: slotId },
    include: { operatorWallet: true },
  });
  if (!slot) throw new Error(`Subaccount slot ${slotId} not found`);
  return slot;
}

export async function getSlotForPosition(positionId: string): Promise<SlotWithWallet | null> {
  return db.subaccountSlot.findUnique({
    where: { positionId },
    include: { operatorWallet: true },
  });
}

/// Deposit confirmed: the slot now backs a live position.
export async function markAllocated(slotId: string): Promise<void> {
  await db.subaccountSlot.update({
    where: { id: slotId },
    data: { status: "allocated", reservationExpiresAt: null },
  });
  log.info("slot allocated", { slotId });
}

/// Position closed and collateral swept -- recycle for the next user.
export async function releaseSlot(slotId: string): Promise<void> {
  await db.subaccountSlot.update({
    where: { id: slotId },
    data: {
      status: "free",
      reservedForUser: null,
      reservedAt: null,
      reservationExpiresAt: null,
      positionId: null,
    },
  });
  log.info("slot released", { slotId });
}

/**
 * Arcus credentials for a slot.
 *
 * The API key is scoped to exactly this (wallet, accountIndex) pair -- a key
 * binds to one index at creation and cannot be reused across them, which is why
 * credentials live on the slot rather than the wallet.
 */
export function credentialsFor(slot: SlotWithWallet): ArcusCredentials {
  return {
    address: slot.operatorWallet.address,
    accountIndex: slot.accountIndex,
    apiKey: slot.arcusApiKey,
    secret: resolveSecret(slot.arcusApiSecretRef),
  };
}

export function operatorEvmKey(slot: SlotWithWallet): string {
  return resolveSecret(slot.operatorWallet.evmSignerRef);
}

/// Verify every slot's stored public key actually matches its secret. A
/// mismatched pair is otherwise invisible until the first order comes back 401.
export async function verifySlotCredentials(): Promise<
  Array<{ slotId: string; accountIndex: number; problem: string }>
> {
  const slots = await db.subaccountSlot.findMany({ include: { operatorWallet: true } });
  const problems: Array<{ slotId: string; accountIndex: number; problem: string }> = [];

  for (const slot of slots) {
    try {
      const secret = resolveSecret(slot.arcusApiSecretRef);
      const derived = publicKeyHex(loadEd25519PrivateKey(secret));
      if (derived.toLowerCase() !== slot.arcusApiKey.toLowerCase()) {
        problems.push({
          slotId: slot.id,
          accountIndex: slot.accountIndex,
          problem: `stored arcus_api_key does not match the key derived from ${slot.arcusApiSecretRef}`,
        });
      }
    } catch (error) {
      problems.push({
        slotId: slot.id,
        accountIndex: slot.accountIndex,
        problem: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return problems;
}

export async function poolStats(): Promise<Record<string, number>> {
  const grouped = await db.subaccountSlot.groupBy({ by: ["status"], _count: { _all: true } });
  const stats: Record<string, number> = { free: 0, reserved: 0, allocated: 0 };
  for (const row of grouped) stats[row.status] = row._count._all;
  return stats;
}
