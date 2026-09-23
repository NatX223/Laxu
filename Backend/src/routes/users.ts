import { Router, type Request } from "express";
import type { User } from "@prisma/client";
import { z } from "zod";

import { authenticatedWallet, requireUser } from "../auth/privy";
import { asyncHandler } from "../lib/async";
import { badRequest, notFound, unauthorized } from "../lib/errors";
import { getUser, updateTag, upsertPrivyUser } from "../services/users";

export const usersRouter = Router();

const serialise = (user: User) => ({
  walletAddress: user.walletAddress,
  tag: user.tag,
  createdAt: user.createdAt.toISOString(),
});

/// Called once after every login. Creates the row (wallet resolved through
/// Privy, default tag, gas drip) the first time, returns it unchanged after.
usersRouter.post(
  "/me",
  requireUser,
  asyncHandler(async (req, res) => {
    const { user, created } = await upsertPrivyUser(req.privyUserId as string);
    res.status(created ? 201 : 200).json(serialise(user));
  }),
);

usersRouter.get(
  "/me",
  requireUser,
  asyncHandler(async (req: Request, res) => {
    if (!req.user) throw unauthorized("Call POST /users/me first", "USER_NOT_REGISTERED");
    res.json(serialise(req.user));
  }),
);

const tagSchema = z.object({ tag: z.string().min(1).max(32) });

usersRouter.patch(
  "/me/tag",
  requireUser,
  asyncHandler(async (req, res) => {
    const parsed = tagSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Invalid request body", "INVALID_REQUEST", parsed.error.issues);
    }
    // updateTag owns the 3-20 [a-z0-9_] rule, after stripping "@" and lowercasing.
    const user = await updateTag(authenticatedWallet(req), parsed.data.tag);
    res.json(serialise(user));
  }),
);

/// Public profile lookup. Address only -- the tag is display, not an identifier
/// anything should be resolved by for authorisation.
usersRouter.get(
  "/:address",
  asyncHandler(async (req, res) => {
    const user = await getUser(req.params.address);
    if (!user) throw notFound("No such user");
    res.json(serialise(user));
  }),
);
