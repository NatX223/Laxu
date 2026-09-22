import { Router } from "express";
import { z } from "zod";

import { issueNonce, requireAuth, verifySignIn } from "../auth/siwe";
import { asyncHandler } from "../lib/async";
import { badRequest } from "../lib/errors";
import { getUser } from "../services/users";

export const authRouter = Router();

authRouter.get(
  "/nonce",
  asyncHandler(async (_req, res) => {
    res.json(await issueNonce());
  }),
);

const verifySchema = z.object({
  message: z.string().min(1),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, "signature must be 0x-prefixed hex"),
});

authRouter.post(
  "/verify",
  asyncHandler(async (req, res) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request body", "INVALID_REQUEST", parsed.error.issues);

    const session = await verifySignIn(parsed.data);
    const user = await getUser(session.address);
    res.json({ ...session, tag: user?.tag });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await getUser(req.wallet as string);
    res.json({ walletAddress: req.wallet, tag: user?.tag ?? null });
  }),
);
