import { sleep } from "../lib/async";
import { createLogger } from "../lib/logger";
import { ConnectionLostError, OrderOutcomeUnknownError } from "../venue/perpl/tradingWs";
import { venue, type OrderOutcome, type OrderSide } from "../venue/types";
import type { SlotWithWallet } from "./allocator";
import type { ResolvedMarket } from "./markets";

const log = createLogger("venue-orders");

/**
 * Market orders for the flows that run inside one handler (buy-ins, redeems,
 * triggers, closes): the `rq`/`lb` are persisted by the caller's `persist`
 * BEFORE the order is sent, and an unknown outcome (timeout, dropped socket)
 * is looked up -- never answered with a second order -- until the venue says
 * what happened or the order can no longer execute.
 */

export interface SentRequest {
  requestId: bigint;
  lastExecBlock: bigint;
}

const LOOKUP_INTERVAL_MS = 2_000;
const LOOKUP_DEADLINE_MS = 3 * 60_000;

export function isUnknownOutcome(error: unknown): boolean {
  return error instanceof OrderOutcomeUnknownError || error instanceof ConnectionLostError;
}

export async function placeAndResolve(
  slot: SlotWithWallet,
  market: ResolvedMarket,
  order: { side: OrderSide; size6: bigint; leverage: number },
  persist: (request: SentRequest) => Promise<void>,
): Promise<OrderOutcome & SentRequest> {
  const request = await venue().nextRequest(slot, market);
  await persist(request);
  try {
    const outcome = await venue().placeMarketOrder(slot, { market, ...order, ...request });
    return { ...outcome, ...request };
  } catch (error) {
    if (!isUnknownOutcome(error)) throw error;
    log.warn("order outcome unknown; looking it up", { slotId: slot.id, rq: request.requestId.toString(), error: String(error) });
    return { ...(await resolveSent(slot, market, request)), ...request };
  }
}

/**
 * The outcome of a request already sent (or perhaps sent): polls the lookup
 * until it is known. `not_placed` -- it can no longer execute -- reads as an
 * unfilled order, after which a NEW rq is safe.
 */
export async function resolveSent(
  slot: SlotWithWallet,
  market: ResolvedMarket,
  request: SentRequest,
  kind: "ioc" | "instant" = "ioc",
): Promise<OrderOutcome> {
  const deadline = Date.now() + LOOKUP_DEADLINE_MS;
  for (;;) {
    const found = await venue().findOrderOutcome(slot, request.requestId, request.lastExecBlock, { market, kind });
    if (found === "not_placed") {
      return {
        status: "unfilled",
        requestId: request.requestId,
        filledSize6: 0n,
        avgPrice18: 0n,
        feeAsset: 0n,
        reason: "not placed before its last execution block",
      };
    }
    if (found !== "pending") return found;
    if (Date.now() > deadline) {
      throw new OrderOutcomeUnknownError(`rq ${request.requestId} still unresolved after ${LOOKUP_DEADLINE_MS}ms`);
    }
    await sleep(LOOKUP_INTERVAL_MS);
  }
}

export function openSide(direction: string): OrderSide {
  return direction === "short" ? "open_short" : "open_long";
}

export function closeSide(direction: string): OrderSide {
  return direction === "short" ? "close_short" : "close_long";
}
