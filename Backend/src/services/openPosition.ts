import type { PositionOpenRequest } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { Address, Hash } from "viem";

import { getPositions, placeOrder, setLeverage } from "../arcus/client";
import { getArcusStream, type OrderOutcome } from "../arcus/ws";
import { db } from "../config/db";
import { config } from "../config/env";
import { usdgAddress, usdgDecimals } from "../chain/clients";
import {
  createPosition,
  ensureLendingPool,
  findExistingPositionToken,
  transferUsdg,
  usdgBalanceOf,
  usdgTransfersIn,
} from "../chain/writes";
import { sleep } from "../lib/async";
import {
  applyBps,
  ceilToStep,
  compareDecimal,
  floorToStep,
  formatDecimal,
  fromBaseUnits,
  isZeroDecimal,
  parseDecimal,
  toBaseUnits,
} from "../lib/decimal";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { alert, createLogger, errorFields } from "../lib/logger";
import {
  credentialsFor,
  getSlot,
  markAllocated,
  releaseSlot,
  reserveSlot,
  type SlotWithWallet,
} from "./allocator";
import {
  depositToSubaccount,
  findCredit,
  waitForCredit,
  waitForWithdrawal,
  walletForSlot,
  withdrawToInternalWallet,
} from "./arcusFunding";
import { markPriceFor, requireMarket, requireMarketByName, type ResolvedMarket } from "./markets";
import { requireRegisteredUser } from "./users";
import { sweepSubaccount } from "./sweep";

const log = createLogger("open-position");

/**
 * Opening a position.
 *
 *   1. The creator pays the reserved slot's internal Arcus wallet (a plain USDG
 *      transfer from their Privy wallet), then reports the tx hash.
 *   2. That internal wallet deposits the USDG into the reserved subaccount via
 *      Arcus's deposit proxy, and trades with the slot's API key.
 *   3. The operator mints the PositionToken to the creator from the confirmed
 *      fill, then creates its LendingPool.
 *
 * Two kinds of wallet, and they never swap roles: the creator pays and owns the
 * PositionToken; the internal wallets receive, deposit and hold the trade, and
 * never appear in Laxu's contracts.
 *
 * Every step writes what it learned to the PositionOpenRequest row before
 * moving on, and each step checks the row (and Arcus) before acting, so a
 * restart resumes rather than repeating a step that moves money. The creator
 * must never be left with money stuck in Laxu's wallets: anything that fails
 * before the fill is refunded.
 */

// Every status a request can be in. `refunding` sits between a failure and
// `refunded` so a refund interrupted by a restart is picked up again.
export type OpenRequestStatus =
  | "awaiting_payment"
  | "payment_received"
  | "deposited"
  | "order_filled"
  | "minted"
  | "refunding"
  | "refunded"
  | "failed";

const TERMINAL: OpenRequestStatus[] = ["minted", "refunded", "failed"];

/// Arcus rejects withdrawals under $1, which is how a post-deposit refund
/// travels -- anything smaller could not be returned.
const MIN_OPEN_AMOUNT = "1";

const CREATE_POOL_ATTEMPTS = 3;
const CREATE_POOL_RETRY_MS = 3_000;
const CREATE_POSITION_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Step 1 -- the creator opens a position on Laxu
// ---------------------------------------------------------------------------

export interface OpenPositionRequest {
  /// Always the logged-in user (`req.user.walletAddress`), never the body.
  userWalletAddress: string;
  /// Laxu symbol ("ETH") or Arcus name ("ETH-USD").
  market: string;
  direction: "long" | "short";
  leverage: number;
  /// Human USDG, e.g. "500".
  amount: string;
}

export interface OpenPositionReservation {
  openRequestId: string;
  /// The slot's internal Arcus wallet -- where the creator sends USDG.
  payTo: string;
  usdg: string;
  /// USDG base units.
  amount: string;
  expiresAt: string;
}

export async function requestOpenPosition(request: OpenPositionRequest): Promise<OpenPositionReservation> {
  const market = await requireMarketByName(request.market);

  if (!Number.isInteger(request.leverage) || request.leverage < 1) {
    throw badRequest("Leverage must be a whole number of at least 1", "INVALID_LEVERAGE");
  }
  if (market.maxLeverage && request.leverage > market.maxLeverage) {
    throw badRequest(`${market.symbol} caps leverage at ${market.maxLeverage}x`, "LEVERAGE_TOO_HIGH");
  }

  const decimals = await usdgDecimals();
  let amount: bigint;
  try {
    amount = toBaseUnits(request.amount, decimals);
  } catch {
    throw badRequest("Amount must be a decimal USDG amount, e.g. \"500\"", "INVALID_AMOUNT");
  }
  if (compareDecimal(request.amount, MIN_OPEN_AMOUNT) < 0) {
    throw badRequest(`Amount must be at least ${MIN_OPEN_AMOUNT} USDG`, "INVALID_AMOUNT");
  }
  if (fromBaseUnits(amount, decimals) !== formatDecimal(parseDecimal(request.amount))) {
    throw badRequest(`Amount has more than ${decimals} decimal places`, "INVALID_AMOUNT");
  }

  const user = await requireRegisteredUser(request.userWalletAddress);

  const { slot, result: openRequest } = await reserveSlot(
    { userWalletAddress: user.walletAddress },
    (tx, slotId) =>
      tx.positionOpenRequest.create({
        data: {
          userWalletAddress: user.walletAddress,
          slotId,
          marketId: market.laxuMarket,
          direction: request.direction,
          leverage: request.leverage,
          amount: amount.toString(),
        },
      }),
  );

  return {
    openRequestId: openRequest.id,
    payTo: slot.operatorWallet.address,
    usdg: usdgAddress(),
    amount: amount.toString(),
    expiresAt: (slot.reservationExpiresAt ?? new Date(Date.now() + config.reservationTimeoutMs)).toISOString(),
  };
}

/**
 * The creator reports their payment transaction. Saves the hash (one payment
 * can never open two positions -- the column is unique), then runs the rest in
 * the background.
 *
 * A payment reported after the reservation already timed out is still
 * verified and refunded: the money is on the internal wallet either way.
 */
export async function reportPayment(params: {
  openRequestId: string;
  callerWalletAddress: string;
  txHash: Hash;
}): Promise<PositionOpenRequest> {
  const request = await requireOwnRequest(params.openRequestId, params.callerWalletAddress);

  if (request.paymentTxHash) {
    if (request.paymentTxHash.toLowerCase() !== params.txHash.toLowerCase()) {
      throw conflict("A different payment is already recorded for this request", "PAYMENT_ALREADY_RECORDED");
    }
    return request;
  }

  const lateButPaid = request.status === "failed";
  if (request.status !== "awaiting_payment" && !lateButPaid) {
    throw conflict(`Request is ${request.status}, not awaiting payment`, "NOT_AWAITING_PAYMENT");
  }

  let updated: PositionOpenRequest;
  try {
    updated = await db.positionOpenRequest.update({
      where: { id: request.id },
      data: { paymentTxHash: params.txHash.toLowerCase(), error: null },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw conflict("That payment has already been used for another position", "PAYMENT_REUSED");
    }
    throw error;
  }

  kick(updated.id);
  return updated;
}

export async function getOpenRequest(openRequestId: string, callerWalletAddress: string) {
  return requireOwnRequest(openRequestId, callerWalletAddress);
}

async function requireOwnRequest(id: string, caller: string): Promise<PositionOpenRequest> {
  const request = await db.positionOpenRequest.findUnique({ where: { id } });
  if (!request) throw notFound(`Open request ${id} not found`);
  if (request.userWalletAddress.toLowerCase() !== caller.toLowerCase()) {
    throw forbidden("Not your open request");
  }
  return request;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/// Requests this process is currently driving -- a resume tick never starts a
/// second driver for one already in flight.
const inFlight = new Set<string>();

function kick(id: string): void {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  void driveOpenRequest(id)
    .catch((error) => log.error("open-position orchestration failed", { openRequestId: id, ...errorFields(error) }))
    .finally(() => inFlight.delete(id));
}

/**
 * Pick up every request left mid-flight -- after a restart, or a step that
 * gave up waiting (Arcus credit slow, createPosition failing). Called from the
 * reconciler tick and once at boot.
 */
export async function resumeOpenRequests(): Promise<number> {
  const stuck = await db.positionOpenRequest.findMany({
    where: {
      OR: [
        { status: { in: ["payment_received", "deposited", "order_filled", "refunding"] } },
        { status: { in: ["awaiting_payment", "failed"] }, paymentTxHash: { not: null }, refundTxHash: null },
      ],
    },
    select: { id: true, status: true, paymentTxHash: true },
  });

  let kicked = 0;
  for (const row of stuck) {
    // A failed request with a payment is a late payment awaiting its refund --
    // unless the failure came after the refund was already sent.
    if (inFlight.has(row.id)) continue;
    kick(row.id);
    kicked += 1;
  }
  return kicked;
}

async function load(id: string): Promise<PositionOpenRequest> {
  const request = await db.positionOpenRequest.findUnique({ where: { id } });
  if (!request) throw notFound(`Open request ${id} not found`);
  return request;
}

async function update(id: string, data: Prisma.PositionOpenRequestUpdateInput): Promise<PositionOpenRequest> {
  return db.positionOpenRequest.update({ where: { id }, data });
}

/**
 * Advance one request as far as it will go. Each branch re-reads the row, so
 * this is safe to call on a request in any state.
 */
export async function driveOpenRequest(id: string): Promise<void> {
  for (;;) {
    const request = await load(id);
    const status = request.status as OpenRequestStatus;
    const slot = await getSlot(request.slotId);

    try {
      if (status === "awaiting_payment") {
        if (!request.paymentTxHash) return; // nothing reported yet
        if (!(await confirmPayment(request, slot))) return;
      } else if (status === "failed") {
        // Only reached for a payment reported after the reservation expired.
        if (!request.paymentTxHash || request.refundTxHash) return;
        if (!(await confirmPayment(request, slot, { late: true }))) return;
        await refund(await load(id), slot, "Payment arrived after the reservation had expired");
        return;
      } else if (status === "payment_received") {
        if (!(await depositPayment(request, slot))) return;
      } else if (status === "deposited") {
        await placeEntry(request, slot);
      } else if (status === "order_filled") {
        await mintPositionToken(request, slot);
      } else if (status === "refunding") {
        await refund(request, slot, request.error ?? "refund resumed");
        return;
      } else {
        return; // minted / refunded
      }
    } catch (error) {
      if (error instanceof RefundableError) {
        log.warn("open request failed before the fill; refunding", {
          openRequestId: id,
          status,
          reason: error.message,
        });
        await refund(await load(id), slot, error.message);
        return;
      }
      await update(id, { error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
      throw error;
    }
  }
}

/// A failure the creator must be refunded for: anything before the fill.
class RefundableError extends Error {}

// ---------------------------------------------------------------------------
// Step 2a -- confirm the creator paid
// ---------------------------------------------------------------------------

/**
 * Read the payment receipt and find the USDG Transfer in it: succeeded,
 * emitted by the USDG contract, from the creator, to this slot's internal
 * wallet, for exactly the requested amount.
 *
 * A mismatch clears the hash (so the creator can report the right one) and
 * leaves the request awaiting payment until the reservation expires.
 */
async function confirmPayment(
  request: PositionOpenRequest,
  slot: SlotWithWallet,
  options: { late?: boolean } = {},
): Promise<boolean> {
  const txHash = request.paymentTxHash as Hash;
  const { status, transfers } = await usdgTransfersIn(txHash);

  const expected = BigInt(request.amount);
  const payment = transfers.find(
    (transfer) =>
      transfer.from.toLowerCase() === request.userWalletAddress.toLowerCase() &&
      transfer.to.toLowerCase() === slot.operatorWallet.address.toLowerCase(),
  );

  let problem: string | undefined;
  if (status !== "success") problem = "the payment transaction reverted";
  else if (!payment) problem = `no USDG transfer from your wallet to ${slot.operatorWallet.address} in that transaction`;
  else if (payment.value !== expected) problem = `paid ${payment.value} base units, expected ${expected}`;

  if (problem) {
    log.warn("payment did not match the open request", { openRequestId: request.id, txHash, problem });
    // Keep a wrong-amount payment on record so it is refunded rather than lost.
    const keep = status === "success" && payment !== undefined;
    await update(request.id, {
      paymentTxHash: keep ? txHash : null,
      error: `Payment rejected: ${problem}`,
      ...(keep ? { status: "refunding", amount: payment.value.toString() } : {}),
    });
    if (keep) await refund(await load(request.id), slot, `Payment rejected: ${problem}`);
    return false;
  }

  if (options.late) return true;

  // The reservation may have expired while the receipt was awaited. Taking the
  // slot's row lock (the same one the reclaim sweep takes) makes the two
  // mutually exclusive: either this claims the payment and clears the expiry,
  // or the sweep got there first and the payment is refunded as late.
  const claimed = await db.$transaction(async (tx) => {
    await lockSlotRow(tx, slot.id);
    const moved = await tx.positionOpenRequest.updateMany({
      where: { id: request.id, status: "awaiting_payment" },
      data: { status: "payment_received", error: null },
    });
    if (moved.count === 0) return false;
    await tx.subaccountSlot.update({ where: { id: slot.id }, data: { reservationExpiresAt: null } });
    return true;
  });

  if (!claimed) {
    await refund(await load(request.id), slot, "Payment arrived after the reservation had expired");
    return false;
  }
  log.info("payment received", { openRequestId: request.id, txHash, amount: expected.toString() });
  return true;
}

async function lockSlotRow(tx: Prisma.TransactionClient, slotId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM subaccount_slots WHERE id = ${slotId} FOR UPDATE`;
}

// ---------------------------------------------------------------------------
// Step 2b -- the internal wallet deposits into the reserved subaccount
// ---------------------------------------------------------------------------

/**
 * `initiateDeposit(owner = internal wallet, slot.accountIndex, USDG, amount)`,
 * then wait for the credit on that exact index.
 *
 * Resume-safe: a credit already on the feed since the request began means the
 * deposit happened (even if the process died before saving its hash), and a
 * saved deposit hash means only the credit is outstanding. A slow credit is
 * not a failure -- the money is in flight to Arcus, so an on-chain refund now
 * could pay twice. The request stays put and the resume tick keeps waiting.
 */
async function depositPayment(request: PositionOpenRequest, slot: SlotWithWallet): Promise<boolean> {
  const since = request.createdAt;
  const existing = await findCredit(slot, since);

  if (!existing && !request.arcusDepositTxHash) {
    let txHash: Hash;
    try {
      txHash = await depositToSubaccount(slot, BigInt(request.amount));
    } catch (error) {
      // Nothing left the internal wallet: refund on-chain.
      throw new RefundableError(`Arcus deposit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await update(request.id, { arcusDepositTxHash: txHash });
  }

  try {
    const { credited } = existing
      ? { credited: toBaseUnits(existing.amount, await usdgDecimals()) }
      : await waitForCredit(slot, since);

    await update(request.id, { status: "deposited", creditedAmount: credited.toString(), error: null });
    log.info("deposit credited", {
      openRequestId: request.id,
      accountIndex: slot.accountIndex,
      credited: credited.toString(),
    });
    return true;
  } catch (error) {
    await update(request.id, { error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
    alert("Arcus deposit not credited yet; will keep checking", {
      openRequestId: request.id,
      accountIndex: slot.accountIndex,
      depositTx: request.arcusDepositTxHash,
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Step 2c -- place the trade with the slot's API key
// ---------------------------------------------------------------------------

async function placeEntry(request: PositionOpenRequest, slot: SlotWithWallet): Promise<void> {
  const market = await requireMarket(request.marketId);
  const credentials = credentialsFor(slot);
  const decimals = await usdgDecimals();

  // A client id on file means an order may already have gone out before a
  // restart. If the leg exists, that order filled -- use it rather than trade
  // twice. (IOC orders resolve immediately, so no leg means it did not fill.)
  if (request.arcusClientId) {
    const leg = (await getPositions(credentials.address, credentials.accountIndex)).find(
      (entry) => entry.marketId === market.arcusMarketId,
    );
    if (leg && !isZeroDecimal(leg.size)) {
      await recordFill(request, {
        orderId: request.arcusOrderId ?? request.arcusClientId,
        averagePrice: leg.averageEntryPrice,
        filledSize: leg.size,
      });
      return;
    }
  }

  let outcome: OrderOutcome;
  try {
    // Isolated at the requested leverage, set before the order so the engine
    // opens the leg isolated -- adjustIsolatedMargin (buy-ins) rejects an
    // account/market pair that is not already isolated.
    await setLeverage(credentials, {
      marketId: market.arcusMarketId,
      leverage: request.leverage,
      isolated: true,
    });

    const clientId = `o${request.id}${Date.now().toString(36)}`.slice(0, 36);
    await update(request.id, { arcusClientId: clientId });

    outcome = await placeEntryOrder({
      direction: request.direction as "long" | "short",
      leverage: request.leverage,
      market,
      credentials,
      collateral: fromBaseUnits(BigInt(request.creditedAmount as string), decimals),
      clientId,
    });
  } catch (error) {
    throw new RefundableError(`Entry order failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // A partial fill counts, at the size that filled.
  if (outcome.unfilled) {
    throw new RefundableError(
      `Entry order did not fill (${outcome.status}${outcome.cancelReason ? `: ${outcome.cancelReason}` : ""})`,
    );
  }

  await recordFill(request, outcome);
}

async function recordFill(
  request: PositionOpenRequest,
  fill: { orderId: string; averagePrice: string; filledSize: string },
): Promise<void> {
  await update(request.id, {
    status: "order_filled",
    arcusOrderId: fill.orderId,
    entryPrice: fill.averagePrice,
    filledSize: fill.filledSize,
    error: null,
  });
  log.info("entry filled", {
    openRequestId: request.id,
    orderId: fill.orderId,
    price: fill.averagePrice,
    size: fill.filledSize,
  });
}

async function placeEntryOrder(params: {
  direction: "long" | "short";
  leverage: number;
  market: ResolvedMarket;
  credentials: ReturnType<typeof credentialsFor>;
  /// Confirmed collateral, human-readable USD.
  collateral: string;
  clientId: string;
}): Promise<OrderOutcome> {
  const { market, credentials, clientId } = params;
  const side = params.direction === "long" ? "BUY" : "SELL";

  const mark = await markPriceFor(market);
  const { price, quantity } = sizeEntry({
    collateral: params.collateral,
    leverage: params.leverage,
    mark,
    side,
    market,
  });

  if (compareDecimal(quantity, market.minOrderSize) < 0) {
    throw new Error(
      `Computed size ${quantity} is below ${market.symbol}'s minimum order size ${market.minOrderSize}`,
    );
  }
  if (!isZeroDecimal(market.maxOrderSize) && compareDecimal(quantity, market.maxOrderSize) > 0) {
    throw new Error(
      `Computed size ${quantity} exceeds ${market.symbol}'s maximum order size ${market.maxOrderSize}`,
    );
  }

  // The listener has to be subscribed and acknowledged BEFORE the REST call:
  // placeOrder answers 202 ACK with no fill data, and the execution arrives only
  // on userFills. Attaching afterwards races the fill.
  const stream = getArcusStream();
  await stream.ensureSubscribed(credentials.address, credentials.accountIndex);
  const waiter = stream.expectOrder({
    address: credentials.address,
    accountIndex: credentials.accountIndex,
    clientId,
  });

  let result;
  try {
    result = await placeOrder(credentials, {
      marketId: market.arcusMarketId,
      side,
      orderType: "MARKET",
      timeInForce: "IOC",
      quantity,
      price,
      clientId,
      tickSize: market.tickSize,
      stepSize: market.stepSize,
    });
  } catch (error) {
    waiter.cancel();
    throw error;
  }

  waiter.bindOrderId(result.orderId);
  return waiter.outcome;
}

/**
 * Size the entry from the collateral actually credited.
 *
 * With isolated margin at `leverage`, the initial margin requirement is
 * notional / leverage -- so putting the whole deposit to work means a notional
 * of `collateral * leverage`, and a size of that over the mark price. The result
 * is floored to the market's step size; the remainder stays as free collateral
 * rather than rounding the order up past what the deposit can margin.
 */
export function sizeEntry(params: {
  collateral: string;
  leverage: number;
  mark: string;
  side: "BUY" | "SELL";
  market: Pick<ResolvedMarket, "tickSize" | "stepSize">;
}): { price: string; quantity: string; notional: string } {
  const collateral = parseDecimal(params.collateral);
  const notional = formatDecimal({
    units: collateral.units * BigInt(params.leverage),
    scale: collateral.scale,
  });

  const markPrice = parseDecimal(params.mark);
  const notionalValue = parseDecimal(notional);
  // notional / mark, carried to 18 places before the step floor.
  const rawQuantity = formatDecimal({
    units:
      (notionalValue.units * 10n ** BigInt(18 + markPrice.scale)) /
      (markPrice.units * 10n ** BigInt(notionalValue.scale)),
    scale: 18,
  });
  const quantity = floorToStep(rawQuantity, params.market.stepSize);

  // MARKET orders take `price` as a protective slippage bound, validated against
  // mark within 10%. A BUY bound sits above mark and floors to the tick; a SELL
  // bound sits below and ceils, so neither is nudged further out of range.
  const bound =
    params.side === "BUY"
      ? applyBps(params.mark, config.arcusSlippageBps, 18)
      : applyBps(params.mark, -config.arcusSlippageBps, 18);
  const price =
    params.side === "BUY"
      ? floorToStep(bound, params.market.tickSize)
      : ceilToStep(bound, params.market.tickSize);

  return { price, quantity, notional };
}

/**
 * The filled size in the unit PositionToken's value math needs. The contract
 * computes pnl as `size * (mark - entry) / 1e18` in USDG base units, with
 * prices at 1e18 -- so `size` must carry the asset quantity scaled by USDG's
 * own decimals, not by 1e18.
 */
export function onChainSize(filledSize: string, usdgDecimalPlaces: number): bigint {
  return toBaseUnits(filledSize, usdgDecimalPlaces);
}

// ---------------------------------------------------------------------------
// Step 3 -- PositionToken, then its LendingPool
// ---------------------------------------------------------------------------

/**
 * The trade is open on Arcus, so the token must exist: createPosition is
 * retried rather than ever releasing the slot or unwinding the trade. The
 * token address is saved the moment it is known, and before any retry the
 * Factory is asked whether this trade already has a token, so a crash can
 * never mint two.
 */
async function mintPositionToken(request: PositionOpenRequest, slot: SlotWithWallet): Promise<void> {
  const creator = request.userWalletAddress as Address;
  const decimals = await usdgDecimals();
  const orderId = request.arcusOrderId as string;

  // --- 3a. createPosition -------------------------------------------------
  let positionToken = request.positionTokenAddress as Address | null;
  if (!positionToken) {
    positionToken = (await findExistingPositionToken(creator, orderId)) ?? null;
  }
  if (!positionToken) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        ({ positionToken } = await createPosition({
          creator,
          market: request.marketId as `0x${string}`,
          direction: request.direction as "long" | "short",
          leverage: request.leverage,
          entryPrice: toBaseUnits(request.entryPrice as string, 18),
          size: onChainSize(request.filledSize as string, decimals),
          initialDeposit: BigInt(request.creditedAmount as string),
          arcusOrderId: orderId,
        }));
        break;
      } catch (error) {
        log.error("createPosition failed; the Arcus trade is open, retrying", {
          openRequestId: request.id,
          attempt,
          ...errorFields(error),
        });
        if (attempt >= CREATE_POSITION_ATTEMPTS) {
          alert("createPosition keeps failing for an open Arcus trade", {
            openRequestId: request.id,
            accountIndex: slot.accountIndex,
          });
          throw error; // left `order_filled`; the resume tick tries again
        }
        await sleep(CREATE_POOL_RETRY_MS * attempt);
        const minted = await findExistingPositionToken(creator, orderId);
        if (minted) {
          positionToken = minted;
          break;
        }
      }
    }
  }

  // Saved before anything else, so a crash from here on resumes instead of
  // minting a second token for the same trade.
  await update(request.id, { positionTokenAddress: positionToken.toLowerCase() });

  // --- 3b. createPool, straight after createPosition confirmed ------------
  const pool = await createPoolWithRetry(positionToken);

  // --- 3c. Ledger + finish ------------------------------------------------
  const tokenAddress = positionToken.toLowerCase();
  const position = await db.$transaction(async (tx) => {
    const row = await tx.position.upsert({
      where: { positionTokenAddress: tokenAddress },
      create: {
        positionTokenAddress: tokenAddress,
        lendingPoolAddress: pool?.toLowerCase() ?? null,
        userWalletAddress: request.userWalletAddress,
        arcusPositionId: orderId,
        arcusOrderId: orderId,
        arcusClientId: request.arcusClientId,
        market: request.marketId,
        direction: request.direction,
        leverage: request.leverage,
        requestedAmount: request.amount,
        depositedAmount: request.creditedAmount,
        entryPrice: toBaseUnits(request.entryPrice as string, 18).toString(),
        size: onChainSize(request.filledSize as string, decimals).toString(),
        status: "open",
        openedAt: new Date(),
      },
      update: pool ? { lendingPoolAddress: pool.toLowerCase() } : {},
    });

    const hasDeposit = await tx.ledgerEntry.findFirst({ where: { positionId: row.id, type: "deposit" } });
    if (!hasDeposit) {
      await tx.ledgerEntry.create({
        data: {
          positionId: row.id,
          type: "deposit",
          amount: request.creditedAmount as string,
          arcusStatus: "confirmed",
          note: `Creator payment ${request.paymentTxHash} -> initiateDeposit ${request.arcusDepositTxHash ?? "(recovered)"}`,
        },
      });
    }

    if (pool) {
      await tx.lendingPool.upsert({
        where: { poolAddress: pool.toLowerCase() },
        create: { poolAddress: pool.toLowerCase(), positionTokenAddress: tokenAddress },
        update: {},
      });
    }
    return row;
  });

  await markAllocated(slot.id, position.id);
  await update(request.id, {
    status: "minted",
    lendingPoolAddress: pool?.toLowerCase() ?? null,
    error: pool ? null : "Lending pool not created yet; retried every minute",
  });

  log.info("position open", {
    openRequestId: request.id,
    positionId: position.id,
    positionToken: tokenAddress,
    lendingPool: pool,
  });
}

/**
 * Up to three attempts a few seconds apart. Failing all of them is not fatal:
 * the position is real and tradeable, only borrowing waits on the pool, and
 * {ensureMissingLendingPools} keeps retrying it every minute.
 */
async function createPoolWithRetry(positionToken: Address): Promise<Address | null> {
  for (let attempt = 1; attempt <= CREATE_POOL_ATTEMPTS; attempt += 1) {
    try {
      return await ensureLendingPool(positionToken);
    } catch (error) {
      log.warn("createPool failed", { positionToken, attempt, ...errorFields(error) });
      if (attempt < CREATE_POOL_ATTEMPTS) await sleep(CREATE_POOL_RETRY_MS);
    }
  }
  alert("lending pool not created; will retry every minute", { positionToken });
  return null;
}

/// Run by the reporter's minute tick: any open position still without a pool.
export async function ensureMissingLendingPools(): Promise<void> {
  const missing = await db.position.findMany({
    where: { status: "open", lendingPoolAddress: null, positionTokenAddress: { not: null } },
    select: { id: true, positionTokenAddress: true },
  });

  for (const position of missing) {
    try {
      const pool = (await ensureLendingPool(position.positionTokenAddress as Address)).toLowerCase();
      await db.$transaction([
        db.position.update({ where: { id: position.id }, data: { lendingPoolAddress: pool } }),
        db.lendingPool.upsert({
          where: { poolAddress: pool },
          create: { poolAddress: pool, positionTokenAddress: position.positionTokenAddress as string },
          update: {},
        }),
        db.positionOpenRequest.updateMany({
          where: { positionTokenAddress: position.positionTokenAddress },
          data: { lendingPoolAddress: pool, error: null },
        }),
      ]);
      log.info("lending pool created on retry", { positionId: position.id, pool });
    } catch (error) {
      log.error("lending pool retry failed", { positionId: position.id, ...errorFields(error) });
    }
  }
}

// ---------------------------------------------------------------------------
// Refunds -- the creator is never left with money stuck in Laxu's wallets
// ---------------------------------------------------------------------------

/**
 * Two shapes, by where the money is:
 *
 *   - Still on the internal wallet (no deposit went out): transfer it back.
 *   - Already on Arcus: withdraw it to the internal wallet, wait for it to
 *     land on-chain, then transfer it back.
 *
 * Each stage is recorded (`refundWithdrawalId`, `refundTxHash`) so a restart
 * picks up where it stopped. Afterwards the slot is swept and freed.
 */
async function refund(request: PositionOpenRequest, slot: SlotWithWallet, reason: string): Promise<void> {
  if (request.refundTxHash) return;
  if (request.status !== "refunding") {
    request = await update(request.id, { status: "refunding", error: reason.slice(0, 500) });
  }

  const creator = request.userWalletAddress as Address;
  const wallet = walletForSlot(slot);
  const walletAddress = slot.operatorWallet.address as Address;

  try {
    // Did this request's money reach Arcus? A saved deposit hash or credit
    // says so. Failing those, a credit on the feed counts only while the slot
    // is still this creator's -- a recycled slot's credits are someone else's.
    const current = await getSlot(slot.id);
    const slotStillOurs =
      current.status === "reserved" && current.reservedForUser === request.userWalletAddress.toLowerCase();
    const deposited =
      Boolean(request.arcusDepositTxHash) ||
      Boolean(request.creditedAmount) ||
      (slotStillOurs && Boolean(await findCredit(slot, request.createdAt)));

    let owed = BigInt(request.amount);
    if (deposited) {
      if (!request.refundWithdrawalId) {
        const credited = BigInt(request.creditedAmount ?? request.amount);
        const { withdrawalId } = await withdrawToInternalWallet(slot, credited);
        request = await update(request.id, { refundWithdrawalId: withdrawalId });
      }
      owed = await waitForWithdrawal(slot, request.refundWithdrawalId as string, request.createdAt);
      await waitForOnChainArrival(walletAddress, owed, request.id);
    }

    const txHash = await transferUsdg(wallet, creator, owed);
    await update(request.id, { status: "refunded", refundTxHash: txHash, error: reason.slice(0, 500) });
    log.info("open request refunded", {
      openRequestId: request.id,
      creator,
      amount: owed.toString(),
      txHash,
    });
  } catch (error) {
    await update(request.id, {
      error: `Refund in progress (${reason}); last attempt: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 500),
    });
    alert("refund did not complete; the resume tick will retry", {
      openRequestId: request.id,
      ...errorFields(error),
    });
    return;
  }

  // Leftover dust (e.g. rounding) goes to index 0 before the slot is reused.
  // Only the slot this request still holds -- a late payment's slot may have
  // been recycled to someone else already.
  const current = await getSlot(slot.id);
  if (current.status === "reserved" && current.reservedForUser === request.userWalletAddress.toLowerCase()) {
    try {
      await sweepSubaccount(current);
      await releaseSlot(slot.id);
    } catch (error) {
      log.error("sweep after refund failed; slot held back", { slotId: slot.id, ...errorFields(error) });
    }
  }
}

/**
 * Withdrawals land on-chain asynchronously. The internal wallet also holds
 * other creators' payments that have not been deposited yet, so the refund
 * waits until its balance covers those AND this refund -- never paying one
 * creator out of another's money.
 */
async function waitForOnChainArrival(wallet: Address, owed: bigint, openRequestId: string): Promise<void> {
  const deadline = Date.now() + config.arcusWithdrawalTimeoutMs;

  while (Date.now() < deadline) {
    const held = await db.positionOpenRequest.findMany({
      where: {
        id: { not: openRequestId },
        status: "payment_received",
        arcusDepositTxHash: null,
        slotId: { in: (await db.subaccountSlot.findMany({
          where: { operatorWallet: { address: { equals: wallet, mode: "insensitive" } } },
          select: { id: true },
        })).map((row) => row.id) },
      },
      select: { amount: true },
    });
    const reserved = held.reduce((sum, row) => sum + BigInt(row.amount), 0n);
    if ((await usdgBalanceOf(wallet)) >= reserved + owed) return;
    await sleep(config.depositPollIntervalMs * 2);
  }
  throw new Error(`Withdrawn USDG has not reached ${wallet} yet`);
}

export { TERMINAL as TERMINAL_OPEN_STATUSES };
