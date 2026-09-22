import type { Position } from "@prisma/client";
import type { Address } from "viem";

import { getAccountTransferUpdates, placeOrder, setLeverage } from "../arcus/client";
import { getArcusStream, type OrderOutcome } from "../arcus/ws";
import type { ArcusCredentials } from "../arcus/types";
import { db } from "../config/db";
import { config } from "../config/env";
import { usdgDecimals } from "../chain/clients";
import { createPosition } from "../chain/writes";
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
import { badRequest, notFound } from "../lib/errors";
import { createLogger, errorFields } from "../lib/logger";
import {
  credentialsFor,
  getSlotForPosition,
  markAllocated,
  releaseSlot,
  reserveSlot,
  type SlotWithWallet,
} from "./allocator";
import { markConfirmed, recordPending } from "./ledger";
import { markPriceFor, requireMarketBySymbol, type ResolvedMarket } from "./markets";
import { ensureUser } from "./users";
import { sweepSubaccount } from "./sweep";

const log = createLogger("open-position");

/**
 * Opening a position, first-time funding.
 *
 * There is no PositionToken yet to lock funds into, so this first deposit
 * bypasses the on-chain vault entirely and goes straight to Arcus. The token is
 * minted afterwards, from the confirmed fill -- which is why the whole flow is
 * asynchronous and the HTTP request only hands back a deposit target.
 */

export interface OpenPositionRequest {
  userWalletAddress: string;
  symbol: string;
  direction: "long" | "short";
  leverage: number;
  /// Collateral the user intends to send, in USDG base units.
  amount: string;
  nickname?: string;
}

export interface OpenPositionReservation {
  positionId: string;
  /// Where the user's Privy wallet should send USDG.
  deposit: {
    address: string;
    accountIndex: number;
    amount: string;
    /// Human-readable, for display.
    amountDisplay: string;
  };
  expiresAt: string;
  market: { symbol: string; arcusDisplayName: string };
}

export async function requestOpenPosition(
  request: OpenPositionRequest,
): Promise<OpenPositionReservation> {
  const market = await requireMarketBySymbol(request.symbol);

  if (request.leverage < 1) throw badRequest("Leverage must be at least 1", "INVALID_LEVERAGE");
  if (market.maxLeverage && request.leverage > market.maxLeverage) {
    throw badRequest(
      `${market.symbol} caps leverage at ${market.maxLeverage}x`,
      "LEVERAGE_TOO_HIGH",
    );
  }
  if (!/^\d+$/.test(request.amount) || BigInt(request.amount) <= 0n) {
    throw badRequest("Amount must be a positive integer string in USDG base units", "INVALID_AMOUNT");
  }

  const user = await ensureUser(request.userWalletAddress);

  const position = await db.position.create({
    data: {
      userWalletAddress: user.walletAddress,
      market: market.laxuMarket,
      direction: request.direction,
      leverage: request.leverage,
      requestedAmount: request.amount,
      nickname: request.nickname?.slice(0, 64) ?? "",
      creatorFeeBps: config.creatorFeeBps,
      status: "pending",
    },
  });

  let slot: SlotWithWallet;
  try {
    slot = await reserveSlot({
      userWalletAddress: user.walletAddress,
      positionId: position.id,
    });
  } catch (error) {
    await db.position.update({
      where: { id: position.id },
      data: { status: "failed", failureReason: "No free subaccount slot available" },
    });
    throw error;
  }

  // The deposit row goes in as `pending` now, before anything moves, so a crash
  // between here and the deposit landing leaves a record of what was expected
  // rather than nothing at all.
  await recordPending({
    positionId: position.id,
    type: "deposit",
    amount: request.amount,
    note: `Awaiting direct USDG deposit to ${slot.operatorWallet.address} index ${slot.accountIndex}`,
  });

  const decimals = await usdgDecimals();
  const expiresAt = slot.reservationExpiresAt ?? new Date(Date.now() + config.reservationTimeoutMs);

  // Drive the rest in the background: the deposit wait alone runs to the
  // reservation timeout, which no HTTP request should hold open.
  void driveOpenPosition(position.id).catch((error) => {
    log.error("open-position orchestration failed", {
      positionId: position.id,
      ...errorFields(error),
    });
  });

  return {
    positionId: position.id,
    deposit: {
      address: slot.operatorWallet.address,
      accountIndex: slot.accountIndex,
      amount: request.amount,
      amountDisplay: fromBaseUnits(BigInt(request.amount), decimals),
    },
    expiresAt: expiresAt.toISOString(),
    market: { symbol: market.symbol, arcusDisplayName: market.arcusDisplayName },
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function driveOpenPosition(positionId: string): Promise<void> {
  const position = await db.position.findUnique({ where: { id: positionId } });
  if (!position) throw notFound(`Position ${positionId} not found`);
  if (position.status !== "pending") {
    log.info("position is no longer pending; nothing to drive", {
      positionId,
      status: position.status,
    });
    return;
  }

  const slot = await getSlotForPosition(positionId);
  if (!slot) throw new Error(`Position ${positionId} has no reserved slot`);

  const market = await requireMarketBySymbol(
    (await db.market.findUnique({ where: { laxuMarket: position.market } }))?.symbol ?? "",
  );
  const credentials = credentialsFor(slot);
  const decimals = await usdgDecimals();

  try {
    // --- 1. Wait for the deposit ------------------------------------------
    const deposited = await waitForDeposit({
      credentials,
      expected: BigInt(position.requestedAmount),
      decimals,
      deadline: slot.reservationExpiresAt ?? new Date(Date.now() + config.reservationTimeoutMs),
    });

    await markAllocated(slot.id);
    await db.position.update({
      where: { id: positionId },
      data: { depositedAmount: deposited.baseUnits.toString() },
    });

    const depositEntry = await db.ledgerEntry.findFirst({
      where: { positionId, type: "deposit" },
      orderBy: { createdAt: "asc" },
    });
    if (depositEntry) {
      await db.ledgerEntry.update({
        where: { id: depositEntry.id },
        data: { amount: deposited.baseUnits.toString() },
      });
      await markConfirmed(depositEntry.id, {
        arcusRequestId: deposited.transferId,
        note: `Arcus DEPOSIT ${deposited.transferId} applied`,
      });
    }

    // --- 2. Isolated margin at the requested leverage ----------------------
    // Set before the order so the engine opens the leg in isolated mode. The
    // margin-add path in the buy-in flow depends on this: adjustIsolatedMargin
    // rejects an account/market pair that is not already isolated.
    await setLeverage(credentials, {
      marketId: market.arcusMarketId,
      leverage: position.leverage,
      isolated: true,
    });

    // --- 3. Place the entry order -----------------------------------------
    const outcome = await placeEntryOrder({
      position,
      market,
      credentials,
      collateral: deposited.display,
    });

    if (outcome.unfilled) {
      throw new Error(
        `Entry order did not fill (${outcome.status}${
          outcome.cancelReason ? `: ${outcome.cancelReason}` : ""
        })`,
      );
    }

    // --- 4. Mint the PositionToken from the confirmed fill ------------------
    const entryPrice = toBaseUnits(outcome.averagePrice, 18);
    const size = toBaseUnits(outcome.filledSize, 18);

    const { positionToken, txHash } = await createPosition({
      creator: position.userWalletAddress as Address,
      market: position.market as `0x${string}`,
      direction: position.direction as "long" | "short",
      leverage: position.leverage,
      entryPrice,
      size,
      initialDeposit: deposited.baseUnits,
      arcusOrderId: outcome.orderId,
      creatorFeeBps: position.creatorFeeBps,
      nickname: position.nickname,
    });

    await db.position.update({
      where: { id: positionId },
      data: {
        status: "open",
        positionTokenAddress: positionToken.toLowerCase(),
        arcusOrderId: outcome.orderId,
        arcusPositionId: outcome.orderId,
        entryPrice: entryPrice.toString(),
        size: size.toString(),
      },
    });

    log.info("position open", {
      positionId,
      positionToken,
      txHash,
      entryPrice: outcome.averagePrice,
      size: outcome.filledSize,
    });
  } catch (error) {
    await failOpenPosition(positionId, slot, error);
    throw error;
  }
}

async function failOpenPosition(
  positionId: string,
  slot: SlotWithWallet,
  error: unknown,
): Promise<void> {
  const reason = error instanceof Error ? error.message : String(error);
  log.error("open-position failed", { positionId, reason });

  await db.position.update({
    where: { id: positionId },
    data: { status: "failed", failureReason: reason.slice(0, 500) },
  });

  // Anything the user already sent is still sitting on the subaccount. Sweep it
  // back to index 0 before recycling the slot, or the next user's balance check
  // would see someone else's money.
  try {
    await sweepSubaccount(slot);
  } catch (sweepError) {
    log.error("sweep after failed open did not complete; slot held back", {
      positionId,
      slotId: slot.id,
      ...errorFields(sweepError),
    });
    return;
  }

  await releaseSlot(slot.id);
}

// ---------------------------------------------------------------------------
// Deposit detection
// ---------------------------------------------------------------------------

interface DepositResult {
  transferId: string;
  baseUnits: bigint;
  display: string;
}

async function waitForDeposit(params: {
  credentials: ArcusCredentials;
  expected: bigint;
  decimals: number;
  deadline: Date;
}): Promise<DepositResult> {
  const seen = new Set<string>();
  const expectedDisplay = fromBaseUnits(params.expected, params.decimals);

  while (Date.now() < params.deadline.getTime()) {
    const updates = await getAccountTransferUpdates(
      params.credentials.address,
      params.credentials.accountIndex,
      { limit: 50 },
    );

    for (const update of updates) {
      if (seen.has(update.id)) continue;
      seen.add(update.id);

      if (update.type !== "DEPOSIT") continue;
      // A rejected transfer reports the pre-op balance and moved nothing.
      if (update.status !== "APPLIED") continue;
      // Spot-asset deposits carry a size in the asset's own units, not USD.
      if (update.spotAssetId && update.spotAssetId > 0) continue;
      // Deposits are reported against the index they landed on, but the filter
      // is re-checked here because a stale page could carry another subaccount.
      if (update.accountIndex !== params.credentials.accountIndex) continue;

      // Accept at or above the expected amount: users overshoot, and refusing a
      // larger deposit would strand it on a slot about to be recycled.
      if (compareDecimal(update.amount, expectedDisplay) < 0) {
        log.warn("deposit smaller than expected, still waiting", {
          accountIndex: params.credentials.accountIndex,
          received: update.amount,
          expected: expectedDisplay,
        });
        continue;
      }

      return {
        transferId: update.id,
        baseUnits: toBaseUnits(update.amount, params.decimals),
        display: update.amount,
      };
    }

    await sleep(config.depositPollIntervalMs);
  }

  throw new Error(
    `No matching DEPOSIT on index ${params.credentials.accountIndex} before the reservation timed out`,
  );
}

// ---------------------------------------------------------------------------
// Entry order
// ---------------------------------------------------------------------------

async function placeEntryOrder(params: {
  position: Position;
  market: ResolvedMarket;
  credentials: ArcusCredentials;
  /// Confirmed collateral, human-readable USD.
  collateral: string;
}): Promise<OrderOutcome> {
  const { market, credentials, position } = params;
  const side = position.direction === "long" ? "BUY" : "SELL";

  const mark = await markPriceFor(market);
  const { price, quantity } = sizeEntry({
    collateral: params.collateral,
    leverage: position.leverage,
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

  // clientId charset is [A-Za-z0-9_-], max 36 -- cuid fits without munging.
  const clientId = position.id.slice(0, 36);
  await db.position.update({ where: { id: position.id }, data: { arcusClientId: clientId } });

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
 * Size the entry from the collateral actually received.
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

export async function getPositionView(positionId: string) {
  const position = await db.position.findUnique({
    where: { id: positionId },
    include: { subaccountSlot: { include: { operatorWallet: true } }, ledgerEntries: true },
  });
  if (!position) throw notFound(`Position ${positionId} not found`);
  return position;
}
