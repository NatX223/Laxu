import type { User } from "@prisma/client";
import { getAddress, isAddress } from "viem";

import { resolvePrivyWallet } from "../auth/privy";
import { db } from "../config/db";
import { badRequest, conflict, HttpError, unauthorized } from "../lib/errors";
import { dripGasInBackground } from "./faucet";

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

const ADJECTIVES = [
  "amber", "brisk", "candid", "dapper", "eager", "frosty", "gilded", "hazy",
  "ivory", "jolly", "keen", "lucid", "mellow", "nimble", "opal", "prime",
  "quiet", "rustic", "sable", "tidal", "umber", "vivid", "witty", "zesty",
];

const NOUNS = [
  "anchor", "beacon", "cinder", "delta", "ember", "falcon", "gable", "harbor",
  "inlet", "juniper", "kestrel", "lantern", "meridian", "nimbus", "orchard",
  "pier", "quarry", "ridge", "summit", "thicket", "upland", "vector", "willow", "zenith",
];

/// `adjective_noun_1234`. The longest pair ("gilded_meridian_") plus the
/// suffix is exactly 20 characters, so every default tag passes TAG_RE.
function randomTag(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const suffix = Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, "0");
  return `${adjective}_${noun}_${suffix}`;
}

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

  // Tags are unique; on the rare collision, try again with a fresh one.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const user = await db.user.create({ data: { walletAddress, privyUserId, tag: randomTag() } });
      dripGasInBackground(walletAddress);
      return { user, created: true };
    } catch (error) {
      // A concurrent POST /users/me for the same login may have won the race.
      const raced = await db.user.findUnique({ where: { privyUserId } });
      if (raced) return { user: raced, created: false };
      if (attempt === 4) throw error;
    }
  }

  throw new Error(`Could not allocate a unique tag for ${walletAddress}`);
}

/// 3-20 characters of `[a-z0-9_]`, stored lowercase.
const TAG_RE = /^[a-z0-9_]{3,20}$/;

export async function updateTag(walletAddress: string, rawTag: string): Promise<User> {
  const address = normaliseAddress(walletAddress);
  const tag = rawTag.trim().replace(/^@/, "").toLowerCase();

  if (!TAG_RE.test(tag)) {
    throw badRequest("Tag must be 3-20 characters of lowercase letters, digits or underscores.", "INVALID_TAG");
  }

  const taken = await db.user.findUnique({ where: { tag } });
  if (taken && taken.walletAddress !== address) {
    throw conflict(`@${tag} is taken`, "TAG_TAKEN");
  }

  try {
    return await db.user.update({ where: { walletAddress: address }, data: { tag } });
  } catch (error) {
    // Lost a race for the same tag between the check above and the write.
    if ((error as { code?: string }).code === "P2002") throw conflict(`@${tag} is taken`, "TAG_TAKEN");
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
