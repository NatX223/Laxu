import type { User } from "@prisma/client";
import { getAddress, isAddress } from "viem";

import { resolvePrivyWallet } from "../auth/privy";
import { db } from "../config/db";
import { badRequest, conflict, HttpError, unauthorized } from "../lib/errors";
import { dripGasInBackground } from "./faucet";
import { allocateTag, isTagCollision, normaliseTag } from "./tags";

/**
 * Identity.
 *
 * The wallet address is identity; backend calls authenticate with a verified
 * Privy access token (see auth/privy.ts). A user row links the Privy user id
 * to the wallet Privy itself reports for them. `tag` is an editable @handle
 * assigned on creation purely so positions have something human to render; it
 * carries no authentication weight and must never be accepted in place of an
 * address.
 */

export function normaliseAddress(address: string): string {
  if (!isAddress(address)) throw badRequest(`Not an EVM address: ${address}`, "INVALID_ADDRESS");
  return getAddress(address).toLowerCase();
}

/**
 * `POST /users/me` -- called once after every login. Idempotent by Privy user
 * id: an existing row comes back untouched. On creation the wallet is
 * resolved through the Privy server SDK, never taken from the request, and a
 * new wallet gets a small gas drip.
 */
export async function upsertPrivyUser(privyUserId: string): Promise<{ user: User; created: boolean }> {
  if (!privyUserId) throw unauthorized();

  const existing = await db.user.findUnique({ where: { privyUserId } });
  if (existing) return { user: existing, created: false };

  const resolved = await resolvePrivyWallet(privyUserId);
  if (!resolved) {
    // Privy creates the embedded wallet just after login; the client retries.
    throw new HttpError(409, "No EVM wallet linked to this Privy user yet", "WALLET_NOT_READY");
  }
  const walletAddress = normaliseAddress(resolved);

  const walletOwner = await db.user.findUnique({ where: { walletAddress } });
  if (walletOwner) {
    throw conflict("This wallet is already registered to another account", "WALLET_TAKEN");
  }

  // Tags are unique; a collision re-draws (see allocateTag).
  return allocateTag(async (tag) => {
    try {
      const user = await db.user.create({ data: { walletAddress, privyUserId, tag } });
      dripGasInBackground(walletAddress);
      return { user, created: true };
    } catch (error) {
      // A concurrent POST /users/me for the same login may have won the race.
      const raced = await db.user.findUnique({ where: { privyUserId } });
      if (raced) return { user: raced, created: false };
      if (isTagCollision(error)) return "taken";
      throw error;
    }
  });
}

export async function updateTag(walletAddress: string, rawTag: string): Promise<User> {
  const address = normaliseAddress(walletAddress);
  const tag = normaliseTag(rawTag);

  const taken = await db.user.findUnique({ where: { tag } });
  if (taken && taken.walletAddress !== address) {
    throw conflict("That name's taken", "TAG_TAKEN");
  }

  try {
    return await db.user.update({ where: { walletAddress: address }, data: { tag } });
  } catch (error) {
    // Lost a race for the same tag between the check above and the write.
    if ((error as { code?: string }).code === "P2002") throw conflict("That name's taken", "TAG_TAKEN");
    throw error;
  }
}

export async function getUser(walletAddress: string): Promise<User | null> {
  return db.user.findUnique({ where: { walletAddress: normaliseAddress(walletAddress) } });
}

/// For flows acting on behalf of an authenticated caller: the row must exist,
/// since only `POST /users/me` may create one (it alone knows the Privy id).
export async function requireRegisteredUser(walletAddress: string): Promise<User> {
  const user = await getUser(walletAddress);
  if (!user) throw unauthorized("Call POST /users/me first", "USER_NOT_REGISTERED");
  return user;
}
