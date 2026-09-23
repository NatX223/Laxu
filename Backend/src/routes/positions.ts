import type { PositionOpenRequest } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";

import { authenticatedWallet, requireUser } from "../auth/privy";
import { db } from "../config/db";
import { asyncHandler } from "../lib/async";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { getNavHistory, getPublicPosition } from "../services/navHistory";
import { getOpenRequest, reportPayment, requestOpenPosition } from "../services/openPosition";
import { bytes32ToSymbol } from "../services/markets";

export const positionsRouter = Router();

const openSchema = z.object({
  /// Laxu symbol ("ETH") or Arcus name ("ETH-USD").
  market: z.string().min(1).max(32),
  direction: z.enum(["long", "short"]),
  leverage: z.number().int().min(1).max(100),
  /// Human USDG as a decimal string ("500") -- never a JS number, which would
  /// lose precision and quietly change how much the user is committing.
  amount: z.string().regex(/^\d+(\.\d+)?$/, "amount must be a decimal string"),
});

/**
 * Step 1 of opening a position: reserve an internal Arcus subaccount and say
 * where to pay. No nickname and no fee here -- the nickname is set when the
 * creator lists the position on-chain, and the buy-in fee is a contract
 * constant. The creator is always the logged-in user, never the body.
 */
positionsRouter.post(
  "/open",
  requireUser,
  asyncHandler(async (req, res) => {
    const parsed = openSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Invalid request body", "INVALID_REQUEST", parsed.error.issues);
    }

    const reservation = await requestOpenPosition({
      userWalletAddress: authenticatedWallet(req),
      ...parsed.data,
    });

    res.status(201).json(reservation);
  }),
);

const paidSchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "txHash must be a 32-byte hex hash"),
});

/// The creator's `USDG.transfer(payTo, amount)` has been sent. The rest runs in
/// the background; poll GET /positions/open/:id.
positionsRouter.post(
  "/open/:id/paid",
  requireUser,
  asyncHandler(async (req, res) => {
    const parsed = paidSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Invalid request body", "INVALID_REQUEST", parsed.error.issues);
    }
    const request = await reportPayment({
      openRequestId: req.params.id,
      callerWalletAddress: authenticatedWallet(req),
      txHash: parsed.data.txHash as `0x${string}`,
    });
    res.status(202).json(serialiseOpenRequest(request));
  }),
);

/// Progress of one open-position attempt -- the frontend's progress screen.
positionsRouter.get(
  "/open/:id",
  requireUser,
  asyncHandler(async (req, res) => {
    const request = await getOpenRequest(req.params.id, authenticatedWallet(req));
    res.json(serialiseOpenRequest(request));
  }),
);

function serialiseOpenRequest(request: PositionOpenRequest) {
  return {
    openRequestId: request.id,
    status: request.status,
    market: request.marketId,
    symbol: safeSymbol(request.marketId),
    direction: request.direction,
    leverage: request.leverage,
    amount: request.amount,
    creditedAmount: request.creditedAmount,
    paymentTxHash: request.paymentTxHash,
    positionTokenAddress: request.positionTokenAddress,
    lendingPoolAddress: request.lendingPoolAddress,
    refundTxHash: request.refundTxHash,
    error: request.error,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

positionsRouter.get(
  "/",
  requireUser,
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

// ---------------------------------------------------------------------------
// Public -- position pages and charts need no login.
// ---------------------------------------------------------------------------

/// Discovery: only positions their creator has listed for buy-ins.
positionsRouter.get(
  "/discover",
  asyncHandler(async (_req, res) => {
    const positions = await db.position.findMany({
      where: { listed: true, status: "open" },
      orderBy: { openedAt: "desc" },
      take: 200,
    });
    res.json({ positions: positions.map(serialise) });
  }),
);

const addressParam = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address");

/// Market, side and entry of a minted position, keyed by its token address.
positionsRouter.get(
  "/token/:positionTokenAddress",
  asyncHandler(async (req, res) => {
    const address = addressParam.safeParse(req.params.positionTokenAddress);
    if (!address.success) throw badRequest("Invalid position token address", "INVALID_ADDRESS");
    res.json(await getPublicPosition(address.data));
  }),
);

const navQuery = z.object({
  /// Server-side downsampling to ~`limit` evenly spaced points (sparklines).
  limit: z.coerce.number().int().min(2).max(1000).optional(),
});

positionsRouter.get(
  "/:positionTokenAddress/nav-history",
  asyncHandler(async (req, res) => {
    const address = addressParam.safeParse(req.params.positionTokenAddress);
    if (!address.success) throw badRequest("Invalid position token address", "INVALID_ADDRESS");
    const query = navQuery.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid query", "INVALID_REQUEST", query.error.issues);
    res.json(await getNavHistory(address.data, query.data.limit));
  }),
);

positionsRouter.get(
  "/:id",
  requireUser,
  asyncHandler(async (req, res) => {
    const position = await db.position.findUnique({
      where: { id: req.params.id },
      include: { subaccountSlot: true, ledgerEntries: true },
    });
    if (!position) throw notFound(`Position ${req.params.id} not found`);
    if (position.userWalletAddress !== authenticatedWallet(req)) {
      throw forbidden("Not your position");
    }

    res.json({
      ...serialise(position),
      slot: position.subaccountSlot
        ? { accountIndex: position.subaccountSlot.accountIndex, status: position.subaccountSlot.status }
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

// Closing is on-chain: the creator calls `requestClose()` on the token, and
// the indexer's CloseRequested handler runs the Arcus unwind and `close()`.

type PositionColumns = NonNullable<Awaited<ReturnType<typeof db.position.findUnique>>>;

function serialise(position: PositionColumns) {
  return {
    id: position.id,
    status: position.status,
    market: position.market,
    symbol: safeSymbol(position.market),
    direction: position.direction,
    leverage: position.leverage,
    nickname: position.nickname,
    listed: position.listed,
    positionTokenAddress: position.positionTokenAddress,
    /// Null while createPool is still being retried -- Borrow stays disabled.
    lendingPoolAddress: position.lendingPoolAddress,
    requestedAmount: position.requestedAmount,
    depositedAmount: position.depositedAmount,
    entryPrice: position.entryPrice,
    size: position.size,
    arcusOrderId: position.arcusOrderId,
    failureReason: position.failureReason,
    liquidated: position.liquidated,
    createdAt: position.createdAt.toISOString(),
    openedAt: position.openedAt?.toISOString() ?? null,
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
