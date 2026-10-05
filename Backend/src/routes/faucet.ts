import { Router, type Request } from "express";

import { requireUser } from "../auth/privy";
import { assetDecimals } from "../chain/clients";
import { config } from "../config/env";
import { asyncHandler } from "../lib/async";
import { unauthorized } from "../lib/errors";
import { claimTestFunds, faucetStatus } from "../services/faucet";
import { normaliseIp, formatTruncated } from "../services/faucetRules";

export const faucetRouter = Router();

async function assetAmount(): Promise<string | null> {
  return config.faucetEnabled
    ? formatTruncated(BigInt(config.faucetAssetAmount), await assetDecimals(), 2).replace(/\.00$/, "")
    : null;
}

function registeredUser(req: Request) {
  if (!req.user) throw unauthorized("Call POST /users/me first", "USER_NOT_REGISTERED");
  return req.user;
}

/// Public: lets a signed-out visitor's UI decide whether to show "Sign in to
/// get test funds" at all. Everything user-specific is behind /status.
faucetRouter.get(
  "/config",
  asyncHandler(async (_req, res) => {
    const amount = await assetAmount();
    res.json({
      enabled: config.faucetEnabled,
      /// `usdgAmount` is the old name for `assetAmount`, kept for the current frontend.
      usdgAmount: amount,
      assetAmount: amount,
    });
  }),
);

faucetRouter.get(
  "/status",
  requireUser,
  asyncHandler(async (req, res) => {
    res.json(await faucetStatus(registeredUser(req), normaliseIp(req.ip)));
  }),
);

/// Takes no body: the recipient is always the signed-in user's stored wallet.
faucetRouter.post(
  "/claim",
  requireUser,
  asyncHandler(async (req, res) => {
    res.json(await claimTestFunds(registeredUser(req), normaliseIp(req.ip)));
  }),
);
