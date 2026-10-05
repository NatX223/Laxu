import type { PositionOpenRequest } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { Address, Hash } from "viem";

import { db } from "../config/db";
import { config } from "../config/env";
import { assetAddress, assetDecimals } from "../chain/clients";
import {
  assetBalanceOf,
  assetTransfersIn,
  createPosition,
  ensureLendingPool,
  findExistingPositionToken,
  receiptStatus,
  transferAsset,
  venuePositionIdFor,
  venuePositionKey,
} from "../chain/writes";
import { sleep } from "../lib/async";
import {
  compareDecimal,
  floorToStep,
  formatDecimal,
  fromBaseUnits,
  isZeroDecimal,
  parseDecimal,
  toBaseUnits,
} from "../lib/decimal";
import { badRequest, conflict, forbidden, notFound, serviceUnavailable } from "../lib/errors";
import { alert, createLogger, errorFields } from "../lib/logger";
import { PRICE_SCALE, fromPrice18, fromSize6, toPrice18, toSize6 } from "../lib/units";
import { getPositions as getApiPositions } from "../venue/perpl/rest";
import { apiAmountToAsset, collateralScale } from "../venue/perpl/units";
import { raiseLastRequestId } from "../venue/requests";
import { venue, type OrderOutcome } from "../venue/types";
import {
  credentialsFor,
  getSlot,
  markAllocated,
  releaseSlot,
  reserveSlot,
  slotWallet,
  type SlotWithWallet,
} from "./allocator";
import { markPriceFor, maxLeverage, requireMarket, requireMarketByName, type ResolvedMarket } from "./markets";
import { requireRegisteredUser } from "./users";
import { sweepSlot } from "./sweep";
import { levelError, levelOf } from "./triggerMath";
import { isUnknownOutcome, openSide } from "./venueOrders";

const log = createLogger("open-position");

/**
 * Opening a position.
 *
 *   1. The creator pays the reserved slot's wallet (a plain asset transfer
 *      from their Privy wallet), then reports the tx hash.
 *   2. That wallet deposits it into its own Perpl account
 *      (`depositCollateral`, credited in the same transaction) and the entry
 *      goes out as an IOC market order over the slot's trading socket.
 *   3. The operator mints the PositionToken to the creator from the position
 *      as the Exchange reports it on-chain -- the same read the token's own
 *      creation check makes -- then creates its LendingPool.
 *
 * Two kinds of wallet, and they never swap roles: the creator pays and owns the
 * PositionToken; the slot wallets receive, deposit and hold the trade, and
 * never appear in Laxu's contracts.
 *
 * Every step writes what it learned to the PositionOpenRequest row before
 * moving on, and each step checks the row (and the venue) before acting, so a
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

const CREATE_POOL_ATTEMPTS = 3;
const CREATE_POOL_RETRY_MS = 3_000;
const CREATE_POSITION_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Step 1 -- the creator opens a position on Laxu
// ---------------------------------------------------------------------------

export interface OpenPositionRequest {
  /// Always the logged-in user (`req.user.walletAddress`), never the body.
  userWalletAddress: string;
  /// Laxu symbol ("ETH") or display name ("ETH-USD").
  market: string;
  direction: "long" | "short";
  leverage: number;
  /// Human asset amount, e.g. "500".
  amount: string;
  /// The creator's stop loss / take profit, human prices of the underlying
  /// ("1900"). Defaults for every holder who buys in; each can override their own.
  stopLoss?: string;
  takeProfit?: string;
}

export interface OpenPositionReservation {
  openRequestId: string;
  /// The slot wallet -- where the creator sends the asset.
  payTo: string;
  /// The asset address. `usdg` is the old name, kept for the current frontend.
  usdg: string;
  asset: string;
  /// Asset base units.
  amount: string;
  expiresAt: string;
}

/// The smallest open: one base unit, or the market's minimum posting amount.
async function minOpenAmount(market: ResolvedMarket): Promise<bigint> {
  const minPosting = apiAmountToAsset(market.minPostingAmount, await collateralScale());
  return minPosting > 1n ? minPosting : 1n;
}

export async function requestOpenPosition(request: OpenPositionRequest): Promise<OpenPositionReservation> {
  const market = await requireMarketByName(request.market);

  const decimals = await assetDecimals();
  let amount: bigint;
  try {
    amount = toBaseUnits(request.amount, decimals);
  } catch {
    throw badRequest('Amount must be a decimal amount, e.g. "500"', "INVALID_AMOUNT");
  }
  if (fromBaseUnits(amount, decimals) !== formatDecimal(parseDecimal(request.amount))) {
    throw badRequest(`Amount has more than ${decimals} decimal places`, "INVALID_AMOUNT");
  }
  const minimum = await minOpenAmount(market);
  if (amount < minimum) {
    throw badRequest(`Amount must be at least ${fromBaseUnits(minimum, decimals)}`, "INVALID_AMOUNT");
  }

  // A fresh mark, not the cached row: sizing and the SL/TP check must use the
  // price the order will actually meet.
  const mark = await markPriceFor(market);
  checkOpenAgainstMarket(market, { leverage: request.leverage, amount: request.amount, mark });
  checkDefaultLevels(request, mark);

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
          stopLoss: nonZero(request.stopLoss),
          takeProfit: nonZero(request.takeProfit),
        },
      }),
  );

  const asset = assetAddress();
  return {
    openRequestId: openRequest.id,
    payTo: slot.operatorWallet.address,
    usdg: asset,
    asset,
    amount: amount.toString(),
    expiresAt: (slot.reservationExpiresAt ?? new Date(Date.now() + config.reservationTimeoutMs)).toISOString(),
  };
}

/// "0" (or blank) means none.
function nonZero(level: string | undefined): string | null {
  return level && !isZeroDecimal(level) ? level : null;
}

/**
 * The creator's SL/TP against the current mark, with the contract's own rule:
 * long SL below / TP above, short the reverse. The contract re-checks against
 * the actual entry at createPosition (see {defaultLevelsAtEntry}).
 */
function checkDefaultLevels(request: OpenPositionRequest, mark: string | null): void {
  const levels = { stopLoss: levelOf(nonZero(request.stopLoss)), takeProfit: levelOf(nonZero(request.takeProfit)) };
  if (levels.stopLoss === 0n && levels.takeProfit === 0n) return;
  if (!mark) throw serviceUnavailable("No mark price to check the stop loss / take profit against", "NO_MARK_PRICE");
  const error = levelError(request.direction, levels, toPrice18(mark));
  if (error) throw badRequest(error, "INVALID_TRIGGER_LEVEL");
}

/**
 * The defaults as createPosition takes them (1e18, 0n = none), checked against
 * the entry. The price can move between the request and the fill; a level the
 * entry has already crossed would make createPosition revert on every retry
 * with the trade open on the venue, so that level is dropped instead -- the
 * position row then shows the defaults that actually apply.
 */
function defaultLevelsAtEntry(request: PositionOpenRequest, entry18: bigint): { stopLoss: bigint; takeProfit: bigint } {
  const side = request.direction === "short" ? "short" : "long";
  let stopLoss = levelOf(request.stopLoss);
  let takeProfit = levelOf(request.takeProfit);
  if (levelError(side, { stopLoss, takeProfit: 0n }, entry18)) {
    log.warn("default stop loss already crossed at the fill; dropped", { openRequestId: request.id, stopLoss: request.stopLoss });
    stopLoss = 0n;
  }
  if (levelError(side, { stopLoss: 0n, takeProfit }, entry18)) {
    log.warn("default take profit already crossed at the fill; dropped", { openRequestId: request.id, takeProfit: request.takeProfit });
    takeProfit = 0n;
  }
  return { stopLoss, takeProfit };
}

/**
 * Everything about the market that can reject an open, checked before a slot
 * is reserved or anything is paid: leverage is within the market's limit, and
 * `amount x leverage` buys at least one lot.
 */
export function checkOpenAgainstMarket(
  market: ResolvedMarket,
  request: { leverage: number; amount: string; mark: string },
): void {
  const name = market.displaySymbol;
  if (!Number.isInteger(request.leverage) || request.leverage < 1) {
    throw badRequest("Leverage must be a whole number of at least 1", "INVALID_LEVERAGE");
  }
  const limit = maxLeverage(market);
  if (request.leverage > limit) {
    throw badRequest(`Max leverage for ${name} is ${limit}x`, "LEVERAGE_TOO_HIGH", { maxLeverage: limit });
  }

  const { lots } = sizeEntry({ collateral: request.amount, leverage: request.leverage, mark: request.mark, market });
  if (lots <= 0n) {
    // One lot at the mark, for the message only.
    const minUsd = Number(market.stepSize) * Number(request.mark);
    const min = (Math.ceil(minUsd * 100) / 100).toFixed(2).replace(/\.00$/, "");
    const minAmount = (Math.ceil(collateralForNotional(minUsd, request.leverage, market) * 100) / 100)
      .toFixed(2)
      .replace(/\.00$/, "");
    throw badRequest(
      `Minimum position size for ${name} is $${min} -- at ${request.leverage}x that needs at least ${minAmount}`,
      "POSITION_TOO_SMALL",
      { minNotional: min, minAmount },
    );
  }
}

/**
 * The creator reports their payment transaction. Saves the hash (one payment
 * can never open two positions -- the column is unique), then runs the rest in
 * the background.
 *
 * A payment reported after the reservation already timed out is still
 * verified and refunded: the money is on the slot wallet either way.
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
 * gave up for now (an order outcome still unknown, createPosition failing, a
 * withdrawal rate-limited). Called from the reconciler tick and once at boot.
 */
export async function resumeOpenRequests(): Promise<number> {
  const stuck = await db.positionOpenRequest.findMany({
    where: {
      OR: [
        { status: { in: ["payment_received", "deposited", "order_filled", "refunding"] } },
        { status: { in: ["awaiting_payment", "failed"] }, paymentTxHash: { not: null }, refundTxHash: null },
      ],
    },
    select: { id: true },
  });

  let kicked = 0;
  for (const row of stuck) {
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
 * this is safe to call on a request in any state. A step that returns false
 * is waiting on something; the resume tick comes back for it.
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
        if (!(await placeEntry(request, slot))) return;
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
 * Read the payment receipt and find the asset Transfer in it: succeeded,
 * emitted by the asset contract, from the creator, to this slot's wallet, for
 * exactly the requested amount.
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
  const { status, transfers } = await assetTransfersIn(txHash);

  const expected = BigInt(request.amount);
  const payment = transfers.find(
    (transfer) =>
      transfer.from.toLowerCase() === request.userWalletAddress.toLowerCase() &&
      transfer.to.toLowerCase() === slot.operatorWallet.address.toLowerCase(),
  );

  let problem: string | undefined;
  if (status !== "success") problem = "the payment transaction reverted";
  else if (!payment) problem = `no asset transfer from your wallet to ${slot.operatorWallet.address} in that transaction`;
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
// Step 2b -- the slot wallet deposits into its own Perpl account
// ---------------------------------------------------------------------------

/**
 * `depositCollateral(amount)` from the slot wallet. Perpl credits it in the
 * same transaction, so a successful receipt IS the credit.
 *
 * Resume-safe: a saved deposit hash is checked by its receipt, never sent
 * again. With no hash saved, a wallet that no longer holds the payment while
 * the account holds reserve + amount means the deposit went out before the
 * hash could be saved.
 */
async function depositPayment(request: PositionOpenRequest, slot: SlotWithWallet): Promise<boolean> {
  const amount = BigInt(request.amount);
  const deposited = () =>
    update(request.id, { status: "deposited", creditedAmount: amount.toString(), error: null }).then(() => {
      log.info("deposit credited", { openRequestId: request.id, slotId: slot.id, amount: amount.toString() });
      return true;
    });

  if (request.depositTxHash) return settleDepositReceipt(request, request.depositTxHash as Hash, deposited);

  const reserve = BigInt(slot.reserve);
  const [walletBalance, accountBalance] = await Promise.all([
    assetBalanceOf(slot.operatorWallet.address as Address),
    venue().accountBalance(slot),
  ]);
  if (walletBalance < amount && accountBalance >= reserve + amount) {
    log.warn("payment no longer on the slot wallet but in the account; the deposit went out", {
      openRequestId: request.id,
      walletBalance: walletBalance.toString(),
      accountBalance: accountBalance.toString(),
    });
    return deposited();
  }

  try {
    await venue().ensureAccountReady(slot);
  } catch (error) {
    // Nothing left the wallet; the slot is unusable for now.
    throw new RefundableError(`Venue account not ready: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await venue().deposit(slot, amount, {
      onSent: async (txHash) => {
        await update(request.id, { depositTxHash: txHash });
      },
    });
  } catch (error) {
    const saved = (await load(request.id)).depositTxHash;
    // Broadcast but not confirmed (or reverted): the receipt decides.
    if (saved) return settleDepositReceipt(request, saved as Hash, deposited);
    // Never broadcast: nothing left the wallet, refund on-chain.
    throw new RefundableError(`Deposit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return deposited();
}

async function settleDepositReceipt(
  request: PositionOpenRequest,
  txHash: Hash,
  deposited: () => Promise<boolean>,
): Promise<boolean> {
  const status = await receiptStatus(txHash);
  if (status === "success") return deposited();
  if (status === "reverted") {
    // The money is still on the slot wallet.
    throw new RefundableError(`Deposit transaction ${txHash} reverted`);
  }
  await update(request.id, { error: `Deposit ${txHash} not confirmed yet; will keep checking` });
  return false;
}

// ---------------------------------------------------------------------------
// Step 2c -- the entry order
// ---------------------------------------------------------------------------

/// Returns false while the order's fate is still unknown.
async function placeEntry(request: PositionOpenRequest, slot: SlotWithWallet): Promise<boolean> {
  const market = await requireMarket(request.marketId);
  const decimals = await assetDecimals();

  // A request id on file means an order may already have gone out before a
  // restart. Never send a second one while the first may be live.
  if (request.venueRequestId && request.venueLastExecBlock) {
    const found = await venue().findOrderOutcome(
      slot,
      BigInt(request.venueRequestId),
      BigInt(request.venueLastExecBlock),
      { market },
    );
    if (found === "pending") return false;
    if (found !== "not_placed") {
      if (found.status === "filled" || found.status === "partial") {
        await recordFillFromChain(request, slot, market, found);
        return true;
      }
      if (found.status === "unfilled") {
        throw new RefundableError(`Entry order did not fill${found.reason ? ` (${found.reason})` : ""}`);
      }
      // failed: fall through to a new order with a new rq.
      log.warn("previous entry order failed; sending a new one", { openRequestId: request.id, reason: found.reason });
    }
  }

  const collateral = fromBaseUnits(BigInt(request.creditedAmount as string), decimals);
  const mark = await markPriceFor(market);
  const { lots, quantity } = sizeEntry({ collateral, leverage: request.leverage, mark, market });
  if (lots <= 0n) throw new RefundableError("Entry is below the market's minimum size");

  const next = await venue().nextRequest(slot, market);
  await db.$transaction(async (tx) => {
    await tx.positionOpenRequest.update({
      where: { id: request.id },
      data: {
        venueRequestId: next.requestId.toString(),
        venueLastExecBlock: next.lastExecBlock.toString(),
      },
    });
    await raiseLastRequestId(tx, slot.id, next.requestId);
  });

  let outcome: OrderOutcome;
  try {
    outcome = await venue().placeMarketOrder(slot, {
      market,
      side: openSide(request.direction),
      size6: toSize6(quantity),
      leverage: request.leverage,
      ...next,
    });
  } catch (error) {
    if (isUnknownOutcome(error)) {
      // The order may be live: stay `deposited`; the resume tick looks it up.
      await update(request.id, { error: `Entry outcome unknown; checking: ${String(error)}`.slice(0, 500) });
      return false;
    }
    throw new RefundableError(`Entry order failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (outcome.status === "unfilled" || outcome.status === "failed") {
    throw new RefundableError(`Entry order did not fill (${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ""})`);
  }
  await recordFillFromChain(request, slot, market, outcome);
  return true;
}

/**
 * The fill as the Exchange holds it: entry and size read from
 * `getPosition` and converted exactly as PerplReader converts them -- the
 * same source the token's creation check compares against, so createPosition
 * cannot mismatch. The order's own fp/fs are logged for audit only.
 */
async function recordFillFromChain(
  request: PositionOpenRequest,
  slot: SlotWithWallet,
  market: ResolvedMarket,
  outcome: OrderOutcome,
): Promise<void> {
  const position = await venue().getPosition(slot, market);
  if (!position.exists || position.direction !== request.direction) {
    // Filled per the venue, but not (yet) on-chain as expected. Not refundable:
    // the resume tick re-reads it.
    throw new Error(
      `Entry filled but the Exchange shows ${position.exists ? `a ${position.direction}` : "no"} position on ${market.symbol}`,
    );
  }
  await update(request.id, {
    status: "order_filled",
    venueOrderId: outcome.orderId ?? null,
    entryPrice: fromPrice18(position.entry18),
    filledSize: fromSize6(position.size6),
    error: null,
  });
  log.info("entry filled", {
    openRequestId: request.id,
    orderId: outcome.orderId,
    orderFillPrice: fromPrice18(outcome.avgPrice18),
    orderFilledSize: fromSize6(outcome.filledSize6),
    venueEntry: fromPrice18(position.entry18),
    venueSize: fromSize6(position.size6),
    fee: outcome.feeAsset.toString(),
  });
}

/// Sizing buffer in parts per million: the taker fee plus the slippage bound.
function bufferPpm(market: Pick<ResolvedMarket, "takerFeeMicros" | "maxSlippageBps">): bigint {
  const slippageBps = Math.min(config.perplSlippageBps, market.maxSlippageBps);
  return BigInt(Math.max(0, market.takerFeeMicros)) + BigInt(slippageBps) * 100n;
}

/**
 * Size the entry from the collateral actually credited.
 *
 * At `leverage`, the initial margin requirement is notional / leverage -- but
 * the taker fee comes out of the same collateral, and the IOC may fill
 * anywhere up to the slippage bound, marking the position at a loss of up to
 * `slippage x notional` straight away. So the collateral must cover
 * `notional x (1/leverage + fee + slippage)`, i.e.
 *
 *   notional = collateral x leverage / (1 + leverage x (fee + slippage))
 *
 * and the size is that over the mark price, floored to whole lots; the
 * remainder stays as free collateral.
 */
export function entryNotional(
  collateral: string,
  leverage: number,
  market: Pick<ResolvedMarket, "takerFeeMicros" | "maxSlippageBps">,
): string {
  const c = parseDecimal(collateral);
  const lev = BigInt(leverage);
  // Six extra places so a whole-dollar collateral does not truncate to dollars.
  return formatDecimal({
    units: (c.units * lev * 1_000_000n * 1_000_000n) / (1_000_000n + lev * bufferPpm(market)),
    scale: c.scale + 6,
  });
}

/// The collateral an entry of `notional` needs -- the inverse of {entryNotional}.
export function collateralForNotional(
  notional: number,
  leverage: number,
  market: Pick<ResolvedMarket, "takerFeeMicros" | "maxSlippageBps">,
): number {
  const buffer = Number(bufferPpm(market)) / 1_000_000;
  return notional * (1 / leverage + buffer);
}

/// Quantity (human, on the lot grid) and whole lots for an entry backed by
/// `collateral`; see {entryNotional}.
export function sizeEntry(params: {
  collateral: string;
  leverage: number;
  mark: string;
  market: Pick<ResolvedMarket, "stepSize" | "sizeDecimals" | "takerFeeMicros" | "maxSlippageBps">;
}): { quantity: string; lots: bigint; notional: string } {
  const notional = entryNotional(params.collateral, params.leverage, params.market);
  const markPrice = parseDecimal(params.mark);
  const notionalValue = parseDecimal(notional);
  if (markPrice.units <= 0n) return { quantity: "0", lots: 0n, notional };
  // notional / mark, carried to 18 places before the lot floor.
  const rawQuantity = formatDecimal({
    units:
      (notionalValue.units * 10n ** BigInt(18 + markPrice.scale)) /
      (markPrice.units * 10n ** BigInt(notionalValue.scale)),
    scale: 18,
  });
  const quantity = floorToStep(rawQuantity, params.market.stepSize);
  const lots = compareDecimal(quantity, "0") > 0 ? toBaseUnits(quantity, params.market.sizeDecimals) : 0n;
  return { quantity, lots, notional };
}

// ---------------------------------------------------------------------------
// Step 3 -- PositionToken, then its LendingPool
// ---------------------------------------------------------------------------

/**
 * The trade is open on the venue, so the token must exist: createPosition is
 * retried rather than ever releasing the slot or unwinding the trade. The
 * token address is saved the moment it is known, and before any retry the
 * Factory is asked whether this trade already has a token, so a crash can
 * never mint two.
 */
async function mintPositionToken(request: PositionOpenRequest, slot: SlotWithWallet): Promise<void> {
  const creator = request.userWalletAddress as Address;
  if (!slot.perplAccountId || !request.venueRequestId) {
    throw new Error(`Open request ${request.id} is order_filled without an account id / request id`);
  }
  const venueKey = venuePositionKey(slot.perplAccountId, request.venueRequestId);
  const venuePositionId = venuePositionIdFor(slot.perplAccountId, request.venueRequestId);
  const entry18 = toPrice18(request.entryPrice as string);
  const size6 = toSize6(request.filledSize as string);
  const defaults = defaultLevelsAtEntry(request, entry18);

  // --- 3a. createPosition -------------------------------------------------
  let positionToken = request.positionTokenAddress as Address | null;
  if (!positionToken) {
    positionToken = (await findExistingPositionToken(creator, venuePositionId)) ?? null;
  }
  if (!positionToken) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        ({ positionToken } = await createPosition({
          creator,
          market: request.marketId as `0x${string}`,
          direction: request.direction as "long" | "short",
          leverage: request.leverage,
          entryPrice: entry18,
          size: size6,
          initialDeposit: BigInt(request.creditedAmount as string),
          venuePositionId,
          venueAccountId: BigInt(slot.perplAccountId),
          defaultStopLoss: defaults.stopLoss,
          defaultTakeProfit: defaults.takeProfit,
        }));
        break;
      } catch (error) {
        log.error("createPosition failed; the venue trade is open, retrying", {
          openRequestId: request.id,
          attempt,
          ...errorFields(error),
        });
        if (attempt >= CREATE_POSITION_ATTEMPTS) {
          alert("createPosition keeps failing for an open venue trade", {
            openRequestId: request.id,
            slotId: slot.id,
            perplAccountId: slot.perplAccountId,
          });
          throw error; // left `order_filled`; the resume tick tries again
        }
        await sleep(CREATE_POOL_RETRY_MS * attempt);
        const minted = await findExistingPositionToken(creator, venuePositionId);
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

  // Best effort: the API's position id, which position stream events carry.
  const market = await requireMarket(request.marketId).catch(() => null);
  let venuePositionPid: string | null = null;
  if (market) {
    try {
      const positions = await getApiPositions(credentialsFor(slot));
      const match = positions.d.find((p) => p.mkt === market.venueMarketId && String(p.acc) === slot.perplAccountId);
      venuePositionPid = match ? String(match.pid) : null;
    } catch (error) {
      log.warn("could not read the venue position id", { openRequestId: request.id, ...errorFields(error) });
    }
  }

  // --- 3c. Ledger + finish ------------------------------------------------
  const tokenAddress = positionToken.toLowerCase();
  const position = await db.$transaction(async (tx) => {
    const row = await tx.position.upsert({
      where: { positionTokenAddress: tokenAddress },
      create: {
        positionTokenAddress: tokenAddress,
        lendingPoolAddress: pool?.toLowerCase() ?? null,
        userWalletAddress: request.userWalletAddress,
        venuePositionId: venueKey,
        venueOrderId: request.venueOrderId,
        venueRequestId: request.venueRequestId,
        venuePositionPid,
        market: request.marketId,
        direction: request.direction,
        leverage: request.leverage,
        requestedAmount: request.amount,
        depositedAmount: request.creditedAmount,
        entryPrice: entry18.toString(),
        size: size6.toString(),
        capital: request.creditedAmount,
        defaultStopLoss: defaults.stopLoss > 0n ? request.stopLoss : null,
        defaultTakeProfit: defaults.takeProfit > 0n ? request.takeProfit : null,
        defaultsActive: defaults.stopLoss > 0n || defaults.takeProfit > 0n,
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
          venueStatus: "confirmed",
          venueRequestId: request.venueRequestId,
          venueOrderId: request.venueOrderId,
          note: `Creator payment ${request.paymentTxHash} -> depositCollateral ${request.depositTxHash ?? "(recovered)"}`,
        },
      });
    }

    // The creator's initial deposit, for cost basis and metrics. Genesis mints
    // 1:1 at NAV 1.0. Keyed on the token (the minting tx is not always known
    // after a recovered createPosition), so a retry upserts the same row.
    await tx.flow.upsert({
      where: { txHash_logIndex: { txHash: `open:${tokenAddress}`, logIndex: 0 } },
      create: {
        positionId: row.id,
        type: "open",
        address: request.userWalletAddress.toLowerCase(),
        assets: request.creditedAmount as string,
        shares: request.creditedAmount as string,
        navPerShare: PRICE_SCALE.toString(),
        txHash: `open:${tokenAddress}`,
        logIndex: 0,
        timestamp: new Date(),
      },
      update: {},
    });

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
 *   - Still on the slot wallet (no deposit went out): transfer it back.
 *   - In the Perpl account: `withdrawCollateral` (synchronous -- it lands on
 *     the slot wallet in the same transaction), then transfer it back.
 *
 * Both transaction hashes are saved the moment they are broadcast
 * (`refundWithdrawTxHash`, `refundTxHash`); a resume checks a saved hash's
 * receipt instead of sending again. A withdrawal that reverts (the exchange's
 * withdrawal rate limit, a halt) leaves the request `refunding` for the resume
 * tick. Afterwards the slot is swept and freed.
 */
async function refund(request: PositionOpenRequest, slot: SlotWithWallet, reason: string): Promise<void> {
  if (request.status === "refunded") return;
  if (request.status !== "refunding") {
    request = await update(request.id, { status: "refunding", error: reason.slice(0, 500) });
  }

  const creator = request.userWalletAddress as Address;
  const walletAddress = slot.operatorWallet.address as Address;
  const wallet = slotWallet(slot);

  try {
    // A transfer home already broadcast: its receipt decides.
    if (request.refundTxHash) {
      const status = await receiptStatus(request.refundTxHash as Hash);
      if (status === "unknown") throw new Error(`refund ${request.refundTxHash} not confirmed yet`);
      if (status === "success") {
        await update(request.id, { status: "refunded" });
        await releaseAfterRefund(request, slot);
        return;
      }
      request = await update(request.id, { refundTxHash: null });
    }

    // Did this request's money reach the account? A saved deposit hash or
    // credit says so.
    const deposited = Boolean(request.depositTxHash) || Boolean(request.creditedAmount);
    let owed = BigInt(request.amount);
    if (deposited) {
      const credited = BigInt(request.creditedAmount ?? request.amount);
      owed = credited;
      const withdrawn = await refundWithdrawal(request, slot, credited);
      if (!withdrawn) return; // waiting on a receipt
    }

    // Pay back no more than the wallet holds of it (a reverted deposit leaves
    // it all here; rounding can leave a unit short).
    const held = await assetBalanceOf(walletAddress);
    if (held < owed) {
      if (held === 0n) throw new Error(`slot wallet holds none of the ${owed} owed`);
      log.warn("slot wallet holds less than owed; refunding what is there", { openRequestId: request.id, held: held.toString(), owed: owed.toString() });
      owed = held;
    }
    const txHash = await transferAsset(wallet, creator, owed, {
      onSent: async (hash) => {
        await update(request.id, { refundTxHash: hash });
      },
    });
    await update(request.id, { status: "refunded", refundTxHash: txHash, error: reason.slice(0, 500) });
    log.info("open request refunded", { openRequestId: request.id, creator, amount: owed.toString(), txHash });
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

  await releaseAfterRefund(await load(request.id), slot);
}

/**
 * The credited amount back out of the account to the slot wallet. True once
 * it is there. Resume-safe: a saved withdrawal hash is checked by its receipt;
 * with none saved, an account already down to its reserve while the wallet
 * holds the amount means it went out before the hash was saved.
 */
async function refundWithdrawal(request: PositionOpenRequest, slot: SlotWithWallet, credited: bigint): Promise<boolean> {
  if (request.refundWithdrawTxHash) {
    const status = await receiptStatus(request.refundWithdrawTxHash as Hash);
    if (status === "success") return true;
    if (status === "unknown") throw new Error(`refund withdrawal ${request.refundWithdrawTxHash} not confirmed yet`);
    await update(request.id, { refundWithdrawTxHash: null }); // reverted: nothing moved
  }

  const reserve = BigInt(slot.reserve);
  const [free, held] = await Promise.all([
    venue().accountBalance(slot),
    assetBalanceOf(slot.operatorWallet.address as Address),
  ]);
  const withdrawable = free > reserve ? free - reserve : 0n;
  if (withdrawable < credited && held >= credited) return true; // already out

  const amount = withdrawable < credited ? withdrawable : credited;
  if (amount <= 0n) throw new Error(`nothing above the reserve to withdraw (free ${free}, reserve ${reserve})`);
  await venue().withdraw(slot, amount, {
    onSent: async (txHash) => {
      await update(request.id, { refundWithdrawTxHash: txHash });
    },
  });
  return true;
}

/// Leftover dust goes to the float before the slot is reused. Only the slot
/// this request still holds -- a late payment's slot may have been recycled
/// to someone else already.
async function releaseAfterRefund(request: PositionOpenRequest, slot: SlotWithWallet): Promise<void> {
  const current = await getSlot(slot.id);
  if (current.status !== "reserved" || current.reservedForUser !== request.userWalletAddress.toLowerCase()) return;
  try {
    await sweepSlot(current);
    await releaseSlot(slot.id);
  } catch (error) {
    log.error("sweep after refund failed; slot held back", { slotId: slot.id, ...errorFields(error) });
  }
}

export { TERMINAL as TERMINAL_OPEN_STATUSES };
