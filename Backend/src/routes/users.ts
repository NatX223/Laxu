import { Router } from "express";
import { z } from "zod";

import { authenticatedWallet, requireAuth } from "../auth/siwe";
import { asyncHandler } from "../lib/async";
import { badRequest, notFound } from "../lib/errors";
import { getUser, updateTag } from "../services/users";

export const usersRouter = Router();

const tagSchema = z.object({ tag: z.string().min(3).max(31) });

usersRouter.patch(
  "/me/tag",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = tagSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Invalid request body", "INVALID_REQUEST", parsed.error.issues);
    }
    const user = await updateTag(authenticatedWallet(req), parsed.data.tag);
    res.json({ walletAddress: user.walletAddress, tag: user.tag });
  }),
);

/// Public profile lookup. Address only -- the tag is display, not an identifier
/// anything should be resolved by for authorisation.
usersRouter.get(
  "/:address",
  asyncHandler(async (req, res) => {
    const user = await getUser(req.params.address);
    if (!user) throw notFound("No such user");
    res.json({
      walletAddress: user.walletAddress,
      tag: user.tag,
      createdAt: user.createdAt.toISOString(),
    });
  }),
);
