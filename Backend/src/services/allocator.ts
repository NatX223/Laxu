import { Prisma, type OperatorWallet, type SubaccountSlot } from "@prisma/client";
import type { WalletClient } from "viem";

import { addressOfKey, slotWalletClient } from "../chain/clients";
import { db } from "../config/db";
import { config } from "../config/env";
import { resolveSecret } from "../config/secrets";
import { loadEd25519PrivateKey } from "../lib/ed25519";
import { serviceUnavailable } from "../lib/errors";
import { createLogger } from "../lib/logger";
import { getWallet } from "../venue/perpl/rest";
import type { PerplCredentials } from "../venue/perpl/types";

const log = createLogger("allocator");

export type SlotWithWallet = SubaccountSlot & { operatorWallet: OperatorWallet };

/**
 * Slot lifecycle:
 *
 *   free -> reserved   (an open request was told to pay this slot's wallet)
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
  // Slots the boot-time verification found a problem with are never handed out.
  const excluded = [...slotProblems.keys()];
  const notExcluded =
    excluded.length > 0 ? Prisma.sql`AND s.id NOT IN (${Prisma.join(excluded)})` : Prisma.empty;

  const claimed = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT s.id
      FROM subaccount_slots s
      JOIN operator_wallets w ON w.id = s.operator_wallet_id
      WHERE s.status = 'free' AND w.status = 'active'
        AND s.perpl_account_id IS NOT NULL AND s.forwarding_enabled = true
        ${notExcluded}
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
    // 503, not 409: nothing is wrong with the request, the pool is just full
    // for now. Nothing has been reserved or paid, so a retry is always safe.
    throw serviceUnavailable(
      "All trading slots are busy right now. Try again in a few minutes.",
      "NO_FREE_SLOT",
    );
  }

  const slot = await getSlot(claimed.slotId);
  log.info("slot reserved", {
    slotId: claimed.slotId,
    perplAccountId: slot.perplAccountId,
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
 * Perpl credentials for a slot: one wallet owns one Perpl account, and its
 * API key is the wallet's. The secret is resolved here, never stored.
 */
export function credentialsFor(slot: SlotWithWallet): PerplCredentials {
  return {
    address: slot.operatorWallet.address,
    perplAccountId: slot.perplAccountId,
    apiKey: slot.apiKey,
    apiSecret: resolveSecret(slot.apiSecretRef),
  };
}

export function operatorEvmKey(slot: SlotWithWallet): string {
  return resolveSecret(slot.operatorWallet.evmSignerRef);
}

/// The slot wallet's signer: it funds, withdraws from and enables forwarding
/// on its own Perpl account, and sends refunds and sweeps.
export function slotWallet(slot: SlotWithWallet): WalletClient {
  return slotWalletClient(operatorEvmKey(slot), slot.operatorWallet.evmSignerRef);
}

export interface SlotProblem {
  slotId: string;
  wallet: string;
  problem: string;
}

/// Problems found by the last {verifySlotCredentials}, by slot. reserveSlot
/// skips these slots; /health lists them.
const slotProblems = new Map<string, SlotProblem[]>();

export function currentSlotProblems(): SlotProblem[] {
  return [...slotProblems.values()].flat();
}

/**
 * Verify every slot end to end, at boot. A slot that fails here would fail on
 * the creator's first order -- after they paid -- so it is reported and kept
 * out of reserveSlot instead:
 *
 *   - the wallet's EVM key resolves and controls the wallet address;
 *   - the API secret resolves and loads as an Ed25519 key;
 *   - `GET /v1/trading/wallet` signed with it answers for this wallet, with an
 *     account whose id is the slot's perplAccountId and `fw == true`.
 */
export async function verifySlotCredentials(): Promise<SlotProblem[]> {
  const slots = await db.subaccountSlot.findMany({ include: { operatorWallet: true } });
  const found = new Map<string, SlotProblem[]>();
  const add = (slot: SlotWithWallet, problem: string) => {
    const list = found.get(slot.id) ?? [];
    list.push({ slotId: slot.id, wallet: slot.operatorWallet.address, problem });
    found.set(slot.id, list);
  };

  for (const slot of slots) {
    try {
      const derived = addressOfKey(operatorEvmKey(slot), slot.operatorWallet.evmSignerRef);
      if (derived.toLowerCase() !== slot.operatorWallet.address.toLowerCase()) {
        add(slot, `EVM key ${slot.operatorWallet.evmSignerRef} does not control ${slot.operatorWallet.address}`);
      }
    } catch (error) {
      add(slot, error instanceof Error ? error.message : String(error));
    }

    if (!slot.perplAccountId) {
      add(slot, "no Perpl account recorded (run slots:provision)");
      continue;
    }

    let credentials: PerplCredentials;
    try {
      credentials = credentialsFor(slot);
      loadEd25519PrivateKey(credentials.apiSecret);
    } catch (error) {
      add(slot, error instanceof Error ? error.message : String(error));
      continue;
    }

    try {
      const wallet = await getWallet(credentials);
      if (wallet.addr.toLowerCase() !== slot.operatorWallet.address.toLowerCase()) {
        add(slot, `API key ${slot.apiKey.slice(0, 8)}... belongs to ${wallet.addr}, not ${slot.operatorWallet.address}`);
      }
      const account = (wallet.as ?? []).find((entry) => String(entry.id) === slot.perplAccountId);
      if (!account) {
        add(slot, `wallet has no Perpl account ${slot.perplAccountId}`);
      } else {
        if (!account.fw) add(slot, `order forwarding is off for account ${slot.perplAccountId}`);
        if (account.fw !== slot.forwardingEnabled) {
          await db.subaccountSlot.update({ where: { id: slot.id }, data: { forwardingEnabled: account.fw } });
        }
      }
    } catch (error) {
      add(slot, `signed wallet read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  slotProblems.clear();
  for (const [slotId, list] of found) slotProblems.set(slotId, list);
  return currentSlotProblems();
}

export interface PoolStats {
  free: number;
  reserved: number;
  allocated: number;
  settling: number;
  total: number;
}

/// Slot counts by status -- slots on a retired wallet are not counted, since
/// reserveSlot never hands them out.
export async function poolStats(): Promise<PoolStats> {
  const grouped = await db.subaccountSlot.groupBy({
    by: ["status"],
    where: { operatorWallet: { status: "active" } },
    _count: { _all: true },
  });
  const stats: PoolStats = { free: 0, reserved: 0, allocated: 0, settling: 0, total: 0 };
  for (const row of grouped) {
    if (row.status in stats && row.status !== "total") stats[row.status as keyof PoolStats] = row._count._all;
    stats.total += row._count._all;
  }
  return stats;
}
