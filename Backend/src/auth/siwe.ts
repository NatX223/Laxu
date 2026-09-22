import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { createPublicClient, http } from "viem";
import { parseSiweMessage, verifySiweMessage, type SiweMessage } from "viem/siwe";

import { db } from "../config/db";
import { config } from "../config/env";
import { badRequest, unauthorized } from "../lib/errors";
import { ensureUser, normaliseAddress } from "../services/users";

/**
 * Wallet address is auth.
 *
 * The frontend connects through Privy and signs a SIWE message; this verifies
 * it and issues a short-lived bearer token. `users.tag` never takes part --
 * it is a display handle and carries no authentication weight.
 */

const NONCE_TTL_MS = 10 * 60_000;

export async function issueNonce(): Promise<{ nonce: string; expiresAt: string }> {
  // SIWE nonces are alphanumeric, at least 8 chars.
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);
  await db.authNonce.create({ data: { nonce, expiresAt } });
  return { nonce, expiresAt: expiresAt.toISOString() };
}

export async function verifySignIn(params: {
  message: string;
  signature: string;
}): Promise<{ token: string; address: string; expiresAt: string }> {
  let parsed: SiweMessage;
  try {
    parsed = parseSiweMessage(params.message) as SiweMessage;
  } catch {
    throw badRequest("Could not parse the SIWE message", "INVALID_SIWE_MESSAGE");
  }

  if (!parsed.nonce) throw badRequest("SIWE message has no nonce", "INVALID_SIWE_MESSAGE");

  // Single use: consumed in one conditional update so two requests replaying the
  // same signature cannot both win.
  const consumed = await db.authNonce.updateMany({
    where: { nonce: parsed.nonce, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (consumed.count !== 1) {
    throw unauthorized("Nonce is unknown, expired, or already used", "INVALID_NONCE");
  }

  const client = createPublicClient({
    transport: http(config.rpcUrl || undefined),
  });

  const valid = await verifySiweMessage(client, {
    message: params.message,
    signature: params.signature as `0x${string}`,
    domain: config.siweDomain,
    nonce: parsed.nonce,
  });

  if (!valid) throw unauthorized("SIWE signature did not verify", "INVALID_SIGNATURE");

  const address = normaliseAddress(parsed.address as string);
  await ensureUser(address);

  const expiresAt = Date.now() + config.sessionTtlMs;
  return {
    token: mintToken(address, expiresAt),
    address,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Bearer tokens. HMAC over `address.expiry`, stateless -- no session table to
// keep in sync, and revocation is a secret rotation.
// ---------------------------------------------------------------------------

function secret(): Buffer {
  if (!config.sessionSecret) {
    throw new Error("SESSION_SECRET is not set; refusing to mint unsigned session tokens");
  }
  return Buffer.from(config.sessionSecret, "utf8");
}

function mintToken(address: string, expiresAt: number): string {
  const body = `${address}.${expiresAt}`;
  const mac = createHmac("sha256", secret()).update(body).digest("hex");
  return `${Buffer.from(body).toString("base64url")}.${mac}`;
}

export function verifyToken(token: string): { address: string } {
  const [encoded, mac] = token.split(".");
  if (!encoded || !mac) throw unauthorized("Malformed token");

  const body = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = createHmac("sha256", secret()).update(body).digest("hex");

  const provided = Buffer.from(mac, "hex");
  const computed = Buffer.from(expected, "hex");
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    throw unauthorized("Token signature does not verify");
  }

  const [address, expiry] = body.split(".");
  if (!address || !expiry) throw unauthorized("Malformed token");
  if (Number(expiry) < Date.now()) throw unauthorized("Token has expired", "TOKEN_EXPIRED");

  return { address };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      wallet?: string;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    next(unauthorized("Missing bearer token"));
    return;
  }
  try {
    req.wallet = verifyToken(header.slice(7).trim()).address;
    next();
  } catch (error) {
    next(error);
  }
}

export function authenticatedWallet(req: Request): string {
  if (!req.wallet) throw unauthorized();
  return req.wallet;
}

/// Housekeeping so the nonce table does not grow without bound.
export async function purgeExpiredNonces(): Promise<number> {
  const { count } = await db.authNonce.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - NONCE_TTL_MS) } },
  });
  return count;
}
