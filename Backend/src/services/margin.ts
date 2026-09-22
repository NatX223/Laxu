import type { Address } from "viem";

import { adjustIsolatedMargin } from "../arcus/client";
import { db } from "../config/db";
import { usdgDecimals } from "../chain/clients";
import {
  fulfillDepositRequest,
  fulfillRedeemRequest,
  navPerShare,
  pendingDeposit,
  pendingRedeem,
} from "../chain/writes";
import { fromBaseUnits, negateDecimal } from "../lib/decimal";
import { createLogger, errorFields } from "../lib/logger";
import { credentialsFor, getSlotForPosition } from "./allocator";
import {
  findEntryForRequest,
  markConfirmed,
  markOnchainFulfilled,
  markReversed,
  recordPending,
} from "./ledger";
import { requireMarket } from "./markets";

const log = createLogger("margin");

/**
 * Adding and removing margin on a position that already exists.
 *
 * Unlike the first deposit, the on-chain vault is live here, so it locks the
 * funds before anything reaches Arcus:
 *
 *   requestDeposit() on-chain  ->  adjustIsolatedMargin on Arcus  ->
 *   fulfillDepositRequest() on-chain
 *
 * The middle step is the one that can succeed while the last one fails: the
 * user may have reclaimed their request after the on-chain timeout, in which
 * case the fulfil reverts and the Arcus-side move has to be undone.
 */

type Direction = "add" | "remove";

interface RequestEvent {
  positionId: string;
  positionTokenAddress: string;
  /// `assets` for a deposit, `shares` for a redeem. USDG base units / shares.
  amount: bigint;
  controller: string;
  requestId: string;
}

export async function handleDepositRequested(event: RequestEvent): Promise<void> {
  await handleMarginRequest("add", event);
}

export async function handleRedeemRequested(event: RequestEvent): Promise<void> {
  await handleMarginRequest("remove", event);
}

async function handleMarginRequest(direction: Direction, event: RequestEvent): Promise<void> {
  const type = direction === "add" ? "margin_add" : "margin_remove";

  // Indexer replays are normal after a restart; one ledger row per on-chain
  // request keeps a re-read of the same block from double-moving margin.
  const existing = await findEntryForRequest({
    positionId: event.positionId,
    type,
    onchainRequestId: event.requestId,
    controller: event.controller,
  });
  if (existing) {
    log.debug("margin request already recorded", {
      entryId: existing.id,
      status: existing.arcusStatus,
    });
    if (existing.arcusStatus === "confirmed" && !existing.onchainFulfilledAt) {
      await completeOnChain(direction, event, existing.id);
    }
    return;
  }

  const position = await db.position.findUnique({ where: { id: event.positionId } });
  if (!position || position.status !== "open") {
    log.warn("margin request for a position that is not open", {
      positionId: event.positionId,
      status: position?.status,
    });
    return;
  }

  const slot = await getSlotForPosition(event.positionId);
  if (!slot) throw new Error(`Position ${event.positionId} has no allocated slot`);

  const market = await requireMarket(position.market);
  const credentials = credentialsFor(slot);
  const decimals = await usdgDecimals();

  // For a redeem the event carries shares, not assets. Value them at the current
  // NAV per share so the amount pulled off Arcus matches what the vault will owe.
  const assets =
    direction === "add"
      ? event.amount
      : (event.amount * (await navPerShare(event.positionTokenAddress as Address))) / 10n ** 18n;

  // `pending` before the Arcus call, always.
  const entry = await recordPending({
    positionId: event.positionId,
    type,
    amount: assets.toString(),
    onchainRequestId: event.requestId,
    controller: event.controller,
    note: `on-chain ${direction === "add" ? "requestDeposit" : "requestRedeem"} ${event.requestId}`,
  });

  const dollars = fromBaseUnits(assets, decimals);
  const amount = direction === "add" ? dollars : negateDecimal(dollars);

  const result = await adjustIsolatedMargin(credentials, {
    marketId: market.arcusMarketId,
    amount,
  });

  await markConfirmed(entry.id, {
    arcusRequestId: result.requestId,
    note: `adjustIsolatedMargin ${amount} -> ${result.status}`,
  });

  await completeOnChain(direction, event, entry.id);
}

/**
 * The on-chain leg, plus the cancellation race.
 *
 * `fulfill*Request` reverts when the controller has no pending request -- which
 * is exactly what a user who reclaimed after the on-chain timeout leaves behind.
 * That is checked before the call rather than inferred from a revert, and when
 * it happens the Arcus-side move is undone with the opposite amount and the
 * ledger row marked `reversed` rather than left claiming money that never
 * settled.
 */
async function completeOnChain(
  direction: Direction,
  event: RequestEvent,
  entryId: string,
): Promise<void> {
  const positionToken = event.positionTokenAddress as Address;
  const controller = event.controller as Address;

  const stillPending =
    direction === "add"
      ? await pendingDeposit(positionToken, controller)
      : await pendingRedeem(positionToken, controller);

  if (stillPending === 0n) {
    await reverseOnArcus(direction, event, entryId, "on-chain request was cancelled or already fulfilled");
    return;
  }

  const fulfillmentPrice = await navPerShare(positionToken);

  try {
    const txHash =
      direction === "add"
        ? await fulfillDepositRequest({ positionToken, controller, fulfillmentPrice })
        : await fulfillRedeemRequest({ positionToken, controller, fulfillmentPrice });

    await markOnchainFulfilled(entryId);
    log.info("margin request fulfilled on-chain", {
      positionId: event.positionId,
      direction,
      txHash,
      fulfillmentPrice: fulfillmentPrice.toString(),
    });
  } catch (error) {
    // The pre-check narrows this a lot, but the request can still be cancelled
    // between the read and the write.
    log.warn("fulfil call failed; reversing the Arcus-side move", {
      positionId: event.positionId,
      direction,
      ...errorFields(error),
    });
    await reverseOnArcus(
      direction,
      event,
      entryId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function reverseOnArcus(
  direction: Direction,
  event: RequestEvent,
  entryId: string,
  reason: string,
): Promise<void> {
  const entry = await db.ledgerEntry.findUnique({ where: { id: entryId } });
  if (!entry) return;

  // Nothing moved on Arcus yet, so there is nothing to undo.
  if (entry.arcusStatus !== "confirmed") {
    await markReversed(entryId, `Not applied on Arcus: ${reason}`);
    return;
  }

  const position = await db.position.findUnique({ where: { id: event.positionId } });
  const slot = await getSlotForPosition(event.positionId);
  if (!position || !slot) {
    log.error("cannot reverse: position or slot missing", { positionId: event.positionId });
    return;
  }

  const market = await requireMarket(position.market);
  const decimals = await usdgDecimals();
  const dollars = fromBaseUnits(BigInt(entry.amount), decimals);
  // Opposite sign of the original move.
  const amount = direction === "add" ? negateDecimal(dollars) : dollars;

  await adjustIsolatedMargin(credentialsFor(slot), {
    marketId: market.arcusMarketId,
    amount,
  });

  await markReversed(entryId, `Reversed on Arcus (${amount}): ${reason}`.slice(0, 500));
}

export type { RequestEvent };
