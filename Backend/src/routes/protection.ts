import { Router, type Request } from "express";
import { z } from "zod";

import { authenticatedWallet, requireUser } from "../auth/privy";
import { asyncHandler } from "../lib/async";
import { badRequest, unauthorized } from "../lib/errors";
import { activateRule, createRule, listRules, turnOffRule, type Caller } from "../services/protection";

/**
 * Loan protection (Spec 05 Part 2). Every route is authenticated and acts on the wallet
 * the backend resolved from Privy for the caller -- an address in a body is never read.
 */
export const protectionRouter = Router();

/// Numbers are accepted as well as strings ("1.15" or 1.15) and turned into the string the validator reads.
const amount = z.union([z.string(), z.number()]).transform((value) => String(value));

const createSchema = z.object({
  pool: z.string(),
  triggerHealth: amount,
  targetHealth: amount,
  /// A human amount of the debt asset ("25" or "25.5"), not base units.
  maxSpend: amount,
});

function caller(req: Request): Caller {
  const walletAddress = authenticatedWallet(req).toLowerCase();
  if (!req.privyUserId) throw unauthorized();
  return { privyUserId: req.privyUserId, walletAddress };
}

/// Creates the rule (disabled) and its Privy policy, and returns what the browser needs for the
/// two user approvals: the signer to add (with the policy id) and the allowance to approve.
protectionRouter.post(
  "/",
  requireUser,
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request body", "INVALID_REQUEST", parsed.error.issues);
    res.status(201).json(await createRule(caller(req), parsed.data));
  }),
);

/// After both approvals. The backend checks the signer with Privy and the allowance on chain itself.
protectionRouter.post(
  "/:id/activate",
  requireUser,
  asyncHandler(async (req, res) => {
    res.json(await activateRule(caller(req), req.params.id));
  }),
);

protectionRouter.get(
  "/",
  requireUser,
  asyncHandler(async (req, res) => {
    res.json(await listRules(caller(req)));
  }),
);

/// Stops the worker immediately. The browser then removes the signer and sets the allowance to 0.
protectionRouter.delete(
  "/:id",
  requireUser,
  asyncHandler(async (req, res) => {
    res.json(await turnOffRule(caller(req), req.params.id));
  }),
);
