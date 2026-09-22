import type { User } from "@prisma/client";
import { getAddress, isAddress } from "viem";

import { db } from "../config/db";
import { badRequest, conflict } from "../lib/errors";

/**
 * Identity.
 *
 * The wallet address is the auth principal -- Privy connection on the frontend,
 * SIWE for backend calls. `tag` is an editable @handle assigned on first connect
 * purely so positions have something human to render; it carries no
 * authentication weight and must never be accepted in place of an address.
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

function randomTag(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const suffix = Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, "0");
  return `${adjective}-${noun}-${suffix}`;
}

export function normaliseAddress(address: string): string {
  if (!isAddress(address)) throw badRequest(`Not an EVM address: ${address}`, "INVALID_ADDRESS");
  return getAddress(address).toLowerCase();
}

/// Idempotent: called on every successful SIWE verification.
export async function ensureUser(walletAddress: string): Promise<User> {
  const address = normaliseAddress(walletAddress);
  const existing = await db.user.findUnique({ where: { walletAddress: address } });
  if (existing) return existing;

  // Tags are unique; on the rare collision, try again with a fresh one.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await db.user.create({ data: { walletAddress: address, tag: randomTag() } });
    } catch (error) {
      const alreadyExists = await db.user.findUnique({ where: { walletAddress: address } });
      if (alreadyExists) return alreadyExists;
      if (attempt === 4) throw error;
    }
  }

  throw new Error(`Could not allocate a unique tag for ${address}`);
}

const TAG_RE = /^[a-z0-9][a-z0-9-_]{2,29}$/;

export async function updateTag(walletAddress: string, rawTag: string): Promise<User> {
  const address = normaliseAddress(walletAddress);
  const tag = rawTag.trim().replace(/^@/, "").toLowerCase();

  if (!TAG_RE.test(tag)) {
    throw badRequest(
      "Tag must be 3-30 characters of lowercase letters, digits, hyphens or underscores, starting with a letter or digit.",
      "INVALID_TAG",
    );
  }

  const taken = await db.user.findUnique({ where: { tag } });
  if (taken && taken.walletAddress !== address) {
    throw conflict(`@${tag} is taken`, "TAG_TAKEN");
  }

  return db.user.update({ where: { walletAddress: address }, data: { tag } });
}

export async function getUser(walletAddress: string): Promise<User | null> {
  return db.user.findUnique({ where: { walletAddress: normaliseAddress(walletAddress) } });
}
