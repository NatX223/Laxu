import { Router } from "express";
import { z } from "zod";

import { authenticatedWallet, requireAuth } from "../auth/siwe";
import { db } from "../config/db";
import { asyncHandler } from "../lib/async";
import { badRequest, forbidden } from "../lib/errors";
import { requestClose } from "../services/closePosition";
import { getPositionView, requestOpenPosition } from "../services/openPosition";
import { bytes32ToSymbol } from "../services/markets";

export const positionsRouter = Router();

const openSchema = z.object({
  symbol: z.string().min(1).max(16),
  direction: z.enum(["long", "short"]),
  leverage: z.number().int().min(1).max(100),
  /// USDG base units, as a string -- never a JS number, which would lose
  /// precision above 2^53 and quietly change how much the user is committing.
  amount: z.string().regex(/^[1-9]\d*$/, "amount must be a positive integer string"),
  nickname: z.string().max(64).optional(),
});

/**
 * Open a position.
 *
 * Returns a deposit target rather than a finished position: there is no
 * PositionToken to lock into yet, so the user's wallet sends USDG straight to
 * the reserved Arcus subaccount and the rest of the flow runs in the
 * background. Poll GET /positions/:id for progress.
 */
positionsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = openSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Invalid request body", "INVALID_REQUEST", parsed.error.issues);
    }

    const reservation = await requestOpenPosition({
      userWalletAddress: authenticatedWallet(req),
      ...parsed.data,
    });

    res.status(202).json(reservation);
  }),
);

positionsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const wallet = authenticatedWallet(req);
    const positions = await db.position.findMany({
      where: { userWalletAddress: wallet },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ positions: positions.map(serialise) });
  }),
);

positionsRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const position = await getPositionView(req.params.id);
    if (position.userWalletAddress !== authenticatedWallet(req)) {
      throw forbidden("Not your position");
    }

    res.json({
      ...serialise(position),
      slot: position.subaccountSlot
        ? {
            accountIndex: position.subaccountSlot.accountIndex,
            depositAddress: position.subaccountSlot.operatorWallet.address,
            status: position.subaccountSlot.status,
            reservationExpiresAt: position.subaccountSlot.reservationExpiresAt?.toISOString() ?? null,
          }
        : null,
      ledger: position.ledgerEntries.map((entry) => ({
        id: entry.id,
        type: entry.type,
        amount: entry.amount,
        arcusStatus: entry.arcusStatus,
        onchainFulfilledAt: entry.onchainFulfilledAt?.toISOString() ?? null,
        createdAt: entry.createdAt.toISOString(),
      })),
    });
  }),
);

/**
 * Close a position.
 *
 * The close-access-control spec routes this through `requestClose()` on-chain,
 * which does not exist on the deployed PositionToken yet. Until it does, this
 * endpoint drives the same orchestration and re-checks the same rule -- caller
 * is the creator, and the creator holds 100% of supply -- off-chain. When the
 * contract ships, the indexer's CloseRequested handler takes over and this
 * stays as the manual path.
 */
positionsRouter.post(
  "/:id/close",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await requestClose({
      positionId: req.params.id,
      callerWalletAddress: authenticatedWallet(req),
    });
    res.status(202).json(result);
  }),
);

type PositionRow = Awaited<ReturnType<typeof getPositionView>>;
/// The plain columns -- `serialise` is shared by the list route, which does not
/// load the slot or ledger relations.
type PositionColumns = Omit<PositionRow, "subaccountSlot" | "ledgerEntries">;

function serialise(position: PositionColumns) {
  return {
    id: position.id,
    status: position.status,
    market: position.market,
    symbol: safeSymbol(position.market),
    direction: position.direction,
    leverage: position.leverage,
    nickname: position.nickname,
    positionTokenAddress: position.positionTokenAddress,
    requestedAmount: position.requestedAmount,
    depositedAmount: position.depositedAmount,
    entryPrice: position.entryPrice,
    size: position.size,
    arcusOrderId: position.arcusOrderId,
    failureReason: position.failureReason,
    createdAt: position.createdAt.toISOString(),
    closedAt: position.closedAt?.toISOString() ?? null,
  };
}

function safeSymbol(market: string): string | null {
  try {
    return bytes32ToSymbol(market);
  } catch {
    return null;
  }
}
