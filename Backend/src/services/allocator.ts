import type { OperatorWallet, Prisma, SubaccountSlot } from "@prisma/client";
import { privateKeyToAccount } from "viem/accounts";

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
 *   free -> reserved   (an open request was told to pay this slot's internal wallet)
 *        -> allocated  (position token minted; the slot is linked to its position)
 *        -> free       (position closed, collateral swept -- or the open request
 *                       failed/refunded -- and the slot recycled)
 *
 * The same slot serves a different user on every cycle, so nothing user-specific
 * may survive the return to `free`.
 */

/// Release reservations that timed out without a payment. Runs before every
/// allocation attempt so an abandoned reservation cannot starve the pool, and
/// again on the reconciliation tick for slots nobody is currently contending.
///
/// Only a request still `awaiting_payment` is expired this way: once payment
/// arrives the expiry is cleared, and a slot holding the creator's money is
/// only ever freed by the refund path.
export async function reclaimExpiredReservations(): Promise<number> {
  const now = new Date();
  const expired = await db.subaccountSlot.findMany({
    where: { status: "reserved", reservationExpiresAt: { lt: now } },
    select: { id: true },
  });
  if (expired.length === 0) return 0;

  let reclaimed = 0;
  for (const slot of expired) {
    const freed = await db.$transaction(async (tx) => {
      // Same row lock confirmPayment takes, so a payment being claimed and an
      // expiry being enforced can never both win.
      const [locked] = await tx.$queryRaw<Array<{ status: string; expires: Date | null }>>`
        SELECT status, reservation_expires_at AS expires FROM subaccount_slots WHERE id = ${slot.id} FOR UPDATE
      `;
      if (!locked || locked.status !== "reserved" || !locked.expires || locked.expires >= now) return false;

      const active = await tx.positionOpenRequest.findFirst({
        where: { slotId: slot.id, status: { notIn: ["minted", "refunded", "failed"] } },
      });
      if (active && active.status !== "awaiting_payment") return false;

      if (active) {
        await tx.positionOpenRequest.update({
          where: { id: active.id },
          data: { status: "failed", error: "No valid payment before the reservation timed out" },
        });
      }
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
      return true;
    });
    if (freed) {
      reclaimed += 1;
      log.warn("reservation expired, slot released", { slotId: slot.id });
    }
  }

  return reclaimed;
}

/**
 * Claim a free slot for a user and run `withSlot` in the same transaction --
 * the open-position flow creates its PositionOpenRequest there, so a slot is
 * never reserved without the request that explains it.
 *
 * `SELECT ... FOR UPDATE SKIP LOCKED` inside the transaction is the part that
 * matters: a transaction on its own does not stop two concurrent open-position
 * requests from reading the same `free` row under Postgres' default READ
 * COMMITTED isolation and both believing they won it. The row lock serialises
 * the claim, and SKIP LOCKED lets a second request move straight to the next
 * free slot instead of blocking behind the first.
 */
export async function reserveSlot<T>(
  params: { userWalletAddress: string },
  withSlot: (tx: Prisma.TransactionClient, slotId: string) => Promise<T>,
): Promise<{ slot: SlotWithWallet; result: T }> {
  await reclaimExpiredReservations();

  const expiresAt = new Date(Date.now() + config.reservationTimeoutMs);

  const claimed = await db.$transaction(async (tx) => {
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
        positionId: null,
      },
    });

    return { slotId: row.id, result: await withSlot(tx, row.id) };
  });

  if (!claimed) {
    throw conflict(
      "No free subaccount slot is available. Every slot in the operator pool is in use.",
      "NO_FREE_SLOT",
    );
  }

  const slot = await getSlot(claimed.slotId);
  log.info("slot reserved", {
    slotId: claimed.slotId,
    accountIndex: slot.accountIndex,
    operatorWallet: slot.operatorWallet.address,
    expiresAt: expiresAt.toISOString(),
  });
  return { slot, result: claimed.result };
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

/// Payment received: the creator's money is now held against this slot, so
/// the reservation must never time out from under it.
export async function clearReservationExpiry(slotId: string): Promise<void> {
  await db.subaccountSlot.update({ where: { id: slotId }, data: { reservationExpiresAt: null } });
}

/// Token minted: the slot now backs a live position.
export async function markAllocated(slotId: string, positionId: string): Promise<void> {
  await db.subaccountSlot.update({
    where: { id: slotId },
    data: { status: "allocated", reservationExpiresAt: null, positionId },
  });
  log.info("slot allocated", { slotId, positionId });
}

/// Position closed (or open request refunded) and collateral swept -- recycle
/// for the next user.
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

  const checkedWallets = new Set<string>();
  for (const slot of slots) {
    // The internal wallet's EVM key signs deposits, refunds and sweeps at
    // runtime; a wrong key would strand a creator's payment on it.
    if (!checkedWallets.has(slot.operatorWalletId)) {
      checkedWallets.add(slot.operatorWalletId);
      try {
        const key = operatorEvmKey(slot);
        const derived = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`).address;
        if (derived.toLowerCase() !== slot.operatorWallet.address.toLowerCase()) {
          problems.push({
            slotId: slot.id,
            accountIndex: slot.accountIndex,
            problem: `EVM key ${slot.operatorWallet.evmSignerRef} does not control ${slot.operatorWallet.address}`,
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
