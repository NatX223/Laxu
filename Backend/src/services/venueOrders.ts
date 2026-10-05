import { sleep } from "../lib/async";
import { createLogger } from "../lib/logger";
import { ConnectionLostError, OrderOutcomeUnknownError } from "../venue/perpl/tradingWs";
import { venue, type OrderOutcome, type OrderSide, type SentRequest } from "../venue/types";
import type { SlotWithWallet } from "./allocator";
import type { ResolvedMarket } from "./markets";

const log = createLogger("venue-orders");

/**
 * Market orders for every flow (entry, buy-in, redeem, trigger, close).
 *
 * Before each send the flow's `persist` saves the `rq`, the `lb`, and the
 * on-chain position size/entry right then. When the socket gives no verdict
 * (timeout, dropped socket, or the testnet forwarder silently losing an
 * accepted order), the outcome is decided on-chain once the chain is past
 * `lb` -- a changed size is a fill by the delta, an unchanged one was never
 * placed -- never by order-history, which lags ~25 s
 * (docs/perpl-findings.md#v-adapter-216). A not-placed order is sent again
 * under a NEW rq, at most MAX_ATTEMPTS times in all; after that the result is
 * `unfilled` and the caller decides (refund / cancel / retry next tick).
 *
 * Callers hold the slot lock across the call, so nothing else moves the size.
 */

export type { SentRequest };

export const MAX_ATTEMPTS = 3;
const LOOKUP_INTERVAL_MS = 1_000;
/// lb is ~20 blocks (~6 s) ahead; this only bounds an RPC that stops advancing.
const LOOKUP_DEADLINE_MS = 3 * 60_000;

export function isUnknownOutcome(error: unknown): boolean {
  return error instanceof OrderOutcomeUnknownError || error instanceof ConnectionLostError;
}

/// The next request for the slot, with the on-chain position as it stands.
export async function prepareRequest(slot: SlotWithWallet, market: ResolvedMarket): Promise<SentRequest> {
  const before = await venue().getPosition(slot, market);
  const next = await venue().nextRequest(slot, market);
  return {
    ...next,
    size6Before: before.exists ? before.size6 : 0n,
    entry18Before: before.exists ? before.entry18 : 0n,
  };
}

export async function placeAndResolve(
  slot: SlotWithWallet,
  market: ResolvedMarket,
  order: { side: OrderSide; size6: bigint; leverage: number },
  persist: (request: SentRequest) => Promise<void>,
  options: { maxAttempts?: number } = {},
): Promise<OrderOutcome & SentRequest & { attempts: number }> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  let request: SentRequest | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    request = await prepareRequest(slot, market);
    await persist(request);
    let outcome: OrderOutcome | "not_placed";
    try {
      outcome = await venue().placeMarketOrder(slot, { market, ...order, ...request });
    } catch (error) {
      if (!isUnknownOutcome(error)) throw error;
      log.warn("order outcome unknown; deciding on-chain", {
        slotId: slot.id,
        rq: request.requestId.toString(),
        attempt,
        error: String(error),
      });
      outcome = await resolveSent(slot, market, request);
    }
    if (outcome !== "not_placed") return { ...outcome, ...request, attempts: attempt };
    log.warn("order was not placed; sending a new rq", { slotId: slot.id, rq: request.requestId.toString(), attempt });
  }
  return {
    ...request!,
    status: "unfilled",
    filledSize6: 0n,
    avgPrice18: 0n,
    feeAsset: 0n,
    reason: `not placed after ${maxAttempts} attempt(s)`,
    attempts: maxAttempts,
  };
}

/**
 * A request already sent (or perhaps sent): waits until the venue's verdict or
 * the lot rule answers. Throws OrderOutcomeUnknownError only if the chain does
 * not move past `lb` in time -- the request's row keeps everything needed to
 * resolve it later.
 */
export async function resolveSent(
  slot: SlotWithWallet,
  market: ResolvedMarket,
  request: SentRequest,
): Promise<OrderOutcome | "not_placed"> {
  const deadline = Date.now() + LOOKUP_DEADLINE_MS;
  for (;;) {
    const found = await venue().findOrderOutcome(slot, request, market);
    if (found !== "pending") return found;
    if (Date.now() > deadline) {
      throw new OrderOutcomeUnknownError(`rq ${request.requestId} still unresolved after ${LOOKUP_DEADLINE_MS}ms`);
    }
    await sleep(LOOKUP_INTERVAL_MS);
  }
}

/// A SentRequest from a row's saved columns, or null when one was never sent.
export function savedRequest(row: {
  venueRequestId: string | null;
  venueLastExecBlock: string | null;
  venueSizeBefore: string | null;
  venueEntryBefore: string | null;
}): SentRequest | null {
  if (!row.venueRequestId || !row.venueLastExecBlock || row.venueSizeBefore === null) return null;
  return {
    requestId: BigInt(row.venueRequestId),
    lastExecBlock: BigInt(row.venueLastExecBlock),
    size6Before: BigInt(row.venueSizeBefore),
    entry18Before: BigInt(row.venueEntryBefore ?? "0"),
  };
}

export function openSide(direction: string): OrderSide {
  return direction === "short" ? "open_short" : "open_long";
}

export function closeSide(direction: string): OrderSide {
  return direction === "short" ? "close_short" : "close_long";
}
