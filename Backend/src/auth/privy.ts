import type { NextFunction, Request, Response } from "express";
import type { User } from "@prisma/client";
import { PrivyClient, type LinkedAccount } from "@privy-io/node";

import { db } from "../config/db";
import { config } from "../config/env";
import { unauthorized } from "../lib/errors";
import { createLogger, errorFields } from "../lib/logger";

const log = createLogger("auth");

/**
 * Wallet address is identity; backend calls are authenticated by verifying the
 * Privy access token the frontend attaches as `Authorization: Bearer ...`.
 *
 * The token proves a Privy user id (DID), not a wallet. The wallet is resolved
 * once, server-side, from Privy's own record of that user (see
 * {resolvePrivyWallet}) and stored on first `POST /users/me` -- an address sent
 * in a request body is never trusted. `users.tag` carries no auth weight.
 */

let client: PrivyClient | undefined;

export function privy(): PrivyClient {
  if (!client) {
    if (!config.privyAppId || !config.privyAppSecret) {
      throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET must be set");
    }
    client = new PrivyClient({
      appId: config.privyAppId,
      appSecret: config.privyAppSecret,
      jwtVerificationKey: config.privyJwtVerificationKey || undefined,
    });
  }
  return client;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      privyUserId?: string;
      /// Null until `POST /users/me` has run once for this Privy user.
      user?: User | null;
    }
  }
}

export async function requireUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    next(unauthorized("Missing bearer token", "MISSING_TOKEN"));
    return;
  }

  let privyUserId: string;
  try {
    const claims = await privy().utils().auth().verifyAccessToken(header.slice(7).trim());
    privyUserId = claims.user_id;
  } catch (error) {
    log.debug("access token rejected", errorFields(error));
    next(unauthorized("Invalid or expired access token", "INVALID_TOKEN"));
    return;
  }

  try {
    req.privyUserId = privyUserId;
    req.user = await db.user.findUnique({ where: { privyUserId } });
    next();
  } catch (error) {
    next(error);
  }
}

/// The caller's wallet, for routes that act on it. Requires the user row, so a
/// client that skipped `POST /users/me` gets a clear error rather than a 404.
export function authenticatedWallet(req: Request): string {
  if (!req.privyUserId) throw unauthorized();
  if (!req.user) throw unauthorized("Call POST /users/me first", "USER_NOT_REGISTERED");
  return req.user.walletAddress;
}

type EthereumWallet = Extract<LinkedAccount, { type: "wallet"; chain_type: "ethereum" }>;

function isEthereumWallet(account: LinkedAccount): account is EthereumWallet {
  return account.type === "wallet" && "chain_type" in account && account.chain_type === "ethereum";
}

/**
 * The address this Privy user acts as. An external-wallet user's is the wallet
 * they connected; an email user's is the embedded wallet Privy created for
 * them (`createOnLogin: "users-without-wallets"`). A user holding both keeps
 * the external one -- they never had an embedded wallet created at login.
 *
 * Returns null when the user has no EVM wallet yet: Privy creates the embedded
 * wallet asynchronously just after login, so a very quick first call can race
 * it. The route maps that to a retryable error.
 */
export async function resolvePrivyWallet(privyUserId: string): Promise<string | null> {
  const user = await privy().users()._get(privyUserId);
  const wallets = user.linked_accounts.filter(isEthereumWallet);

  const external = wallets.find((wallet) => wallet.wallet_client_type !== "privy");
  const embedded = wallets
    .filter((wallet) => wallet.wallet_client_type === "privy")
    .sort((a, b) => ("wallet_index" in a ? a.wallet_index : 0) - ("wallet_index" in b ? b.wallet_index : 0))[0];

  return (external ?? embedded)?.address.toLowerCase() ?? null;
}
