import type { LedgerEntry, Position, Prisma } from "@prisma/client";
import type { Address } from "viem";

import { publicClient } from "../chain/clients";
import { positionTokenAbi } from "../chain/abi";
import {
  executeTrigger,
  isClosed,
  navPerShare,
  readPositionState,
  retireDefaultTriggers,
  shareBalanceOf,
} from "../chain/writes";
import { db } from "../config/db";
import { alert, createLogger, errorFields } from "../lib/logger";
import { PRICE_SCALE, fromPrice18, fromSize6 } from "../lib/units";
import { saveLedgerRequest } from "../venue/requests";
import { venue } from "../venue/types";
import type { SlotWithWallet } from "./allocator";
import { settleEmptiedPosition } from "./closePosition";
import { withSlotLock } from "./float";
import { markOnchainFulfilled, markReversed, recordPending } from "./ledger";
import { fundPayout, recycleFreedMargin } from "./margin";
import type { ResolvedMarket } from "./markets";
import { pushFreshFunding } from "./reporter";
import { redeemClosedSize } from "./sizing";
import { effectiveLevels, levelsHit, splitClosedSize, type Side } from "./triggerMath";
import { closeSide, placeAndResolve } from "./venueOrders";

const log = createLogger("triggers");

/**
 * Per-holder stop loss / take profit, evaluated on the reporter's minute tick
 * against the token's own currentMark() -- the live venue mark the contract
 * itself checks.
 *
 * All holders share one venue position, so a trigger can't be a stop order on
 * it -- that would close it for everyone. A fired trigger is an automatic
 * redeem of that one holder's wallet balance instead:
 *
 *   1. find holders whose effective level the mark has crossed
 *   2. push fresh funding (the payout is priced at navPerShare())
 *   3. ONE close IOC order for their combined proportional size
 *   4. fund the token for Σ shares x navPerShare()
 *   5. executeTrigger(holder, slice, fill) for each -- the closed size (token
 *      size less the venue size after the order) shared out by shares, the
 *      last holder taking the rounding remainder
 *   6. retireDefaultTriggers() if anyone in the batch was on the defaults
 *
 * The contract re-checks every holder's own level against the LIVE venue
 * mark, so the operator can only ever exit someone whose level is breached.
 * If the mark moved back (or the venue can't be read) for a holder, they are
 * left for the next tick -- not marked done.
 *
 * Crash safety follows the ledger rule: a `trigger_exit` row is written
 * `pending` before the order (its rq/lb saved before sending), `confirmed`
 * with the fill and the per-holder split (`batch`) after it, and each
 * executeTrigger ticks its holder `done`.
 */

interface BatchHolder {
  holder: string;
  shares: string;
  /// This holder's slice of the fill, size6.
  closedSize: string;
  usedDefault: boolean;
  done: boolean;
}

interface Batch {
  /// The mark the batch was decided at, 1e18.
  mark18: string;
  fillPrice18: string;
  holders: BatchHolder[];
}

export interface TriggerContext {
  position: Position;
  slot: SlotWithWallet;
  market: ResolvedMarket;
  positionToken: Address;
}

/// A pending batch older than this is stuck, not in flight.
const PENDING_STALE_MS = 5 * 60_000;

/// One batch per position at a time in this process.
const running = new Set<string>();

function sideOf(position: Position): Side {
  return position.direction === "short" ? "short" : "long";
}

/**
 * Holders the DB mirror says are triggered at `mark18`: wallet balance > 0
 * (LendingPool addresses excluded -- collateral is the pool's, not the
 * holder's), effective levels from their HolderTrigger row or the defaults.
 */
export async function triggeredHolders(position: Position, mark18: bigint): Promise<string[]> {
  const token = (position.positionTokenAddress ?? "").toLowerCase();
  const [holdings, overrides, pools] = await Promise.all([
    db.holding.findMany({ where: { positionId: position.id } }),
    db.holderTrigger.findMany({ where: { positionId: position.id } }),
    db.lendingPool.findMany({ where: { positionTokenAddress: token }, select: { poolAddress: true } }),
  ]);
  const poolSet = new Set(pools.map((p) => p.poolAddress.toLowerCase()));
  const byHolder = new Map(overrides.map((row) => [row.holder.toLowerCase(), row]));
  const side = sideOf(position);

  return holdings
    .filter((h) => BigInt(h.balance) > 0n && !poolSet.has(h.address.toLowerCase()))
    .filter((h) => {
      const hit = levelsHit(side, effectiveLevels(byHolder.get(h.address.toLowerCase()), position), mark18);
      return hit.slHit || hit.tpHit;
    })
    .map((h) => h.address.toLowerCase());
}

/// Finishes an interrupted batch first; otherwise evaluates and runs a new one.
export async function processTriggers(ctx: TriggerContext): Promise<void> {
  const id = ctx.position.id;
  if (running.has(id)) return;
  running.add(id);
  try {
    // A close owns the venue position from here on.
    if (await db.settlement.findUnique({ where: { positionId: id }, select: { positionId: true } })) return;

    const unfinished = await db.ledgerEntry.findFirst({
      where: { positionId: id, type: "trigger_exit", venueStatus: { in: ["pending", "confirmed"] }, onchainFulfilledAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (unfinished) {
      if (unfinished.venueStatus === "confirmed") {
        await finishOnChain(ctx, unfinished);
      } else if (Date.now() - unfinished.createdAt.getTime() > PENDING_STALE_MS) {
        // The order's fate is unknown; placing another could double the reduce.
        alert("trigger batch stuck in pending; triggers paused for this position", {
          entryId: unfinished.id,
          positionId: id,
          requestId: unfinished.venueRequestId,
        });
      }
      return;
    }

    await runBatch(ctx);
  } finally {
    running.delete(id);
  }
}

/// A batch confirmed on the venue but not finished on-chain (or stuck pending).
export async function hasUnfinishedBatch(positionId: string): Promise<boolean> {
  const entry = await db.ledgerEntry.findFirst({
    where: { positionId, type: "trigger_exit", venueStatus: { in: ["pending", "confirmed"] }, onchainFulfilledAt: null },
    select: { id: true },
  });
  return entry !== null;
}

async function runBatch(ctx: TriggerContext): Promise<void> {
  const token = ctx.positionToken;
  let state = await readPositionState(token);
  if (state.closed) return;

  // The DB narrows the list; the chain decides, at the token's currentMark().
  const candidates = await triggeredHolders(ctx.position, state.markPrice);
  if (candidates.length === 0) return;

  const side = sideOf(ctx.position);
  const holders: BatchHolder[] = [];
  for (const holder of candidates) {
    const [shares, [stopLoss, takeProfit, usingDefault]] = await Promise.all([
      shareBalanceOf(token, holder as Address),
      publicClient().readContract({
        address: token,
        abi: positionTokenAbi,
        functionName: "effectiveTriggers",
        args: [holder as Address],
      }) as Promise<readonly [bigint, bigint, boolean]>,
    ]);
    const hit = levelsHit(side, { stopLoss, takeProfit }, state.markPrice);
    if (shares > 0n && (hit.slHit || hit.tpHit)) {
      holders.push({ holder, shares: shares.toString(), closedSize: "0", usedDefault: usingDefault, done: false });
    }
  }
  if (holders.length === 0) return;

  // The exits are paid at navPerShare(): make it current first.
  await pushFreshFunding(ctx.position, ctx.slot, ctx.market);
  state = await readPositionState(token);

  const shares = holders.map((h) => BigInt(h.shares));
  const exiting = shares.reduce((sum, s) => sum + s, 0n);
  const nav = await navPerShare(token);
  const leg = await venue().getPosition(ctx.slot, ctx.market);

  // Σ shares / supply of the size, on the grid; the whole leg for a full exit;
  // 0 below the minimum order size (then paid from the buffer alone).
  const closedSize6 = redeemClosedSize({
    shares: exiting,
    supply: state.totalSupply,
    size6: state.size,
    legSize6: leg.exists ? leg.size6 : 0n,
    mark18: state.markPrice,
    grid: ctx.market,
  });

  const entry = await recordPending({
    positionId: ctx.position.id,
    type: "trigger_exit",
    amount: ((exiting * nav) / PRICE_SCALE).toString(),
    requestAmount: exiting.toString(),
    note: `SL/TP batch at ${fromPrice18(state.markPrice)}: ${holders.length} holder(s)`,
  });
  const batch: Batch = { mark18: state.markPrice.toString(), fillPrice18: "0", holders };
  await db.ledgerEntry.update({ where: { id: entry.id }, data: { batch: batch as unknown as Prisma.InputJsonValue } });

  log.info("SL/TP triggered", {
    positionId: ctx.position.id,
    mark: fromPrice18(state.markPrice),
    holders: holders.map((h) => h.holder),
    closedSize: fromSize6(closedSize6),
  });

  let fill18 = 0n;
  if (closedSize6 > 0n && leg.exists) {
    const outcome = await withSlotLock(ctx.slot.id, () =>
      placeAndResolve(
        ctx.slot,
        ctx.market,
        { side: closeSide(ctx.position.direction), size6: closedSize6, leverage: ctx.position.leverage },
        (request) => saveLedgerRequest(entry.id, ctx.slot.id, request),
      ),
    );
    if (outcome.status === "unfilled" || outcome.status === "failed") {
      // Nothing moved; the holders are still breached, so the next tick retries.
      await markReversed(entry.id, `trigger order did not fill (${outcome.status}); retried next tick`);
      log.warn("trigger order did not fill", { positionId: ctx.position.id, status: outcome.status, reason: outcome.reason });
      return;
    }
    fill18 = outcome.avgPrice18;
  }

  // The closed size as the chain sees it.
  const after = await venue().getPosition(ctx.slot, ctx.market);
  const venueAfter = after.exists ? after.size6 : 0n;
  const filled6 = state.size > venueAfter ? state.size - venueAfter : 0n;
  if (filled6 > 0n && fill18 === 0n) fill18 = state.markPrice;
  if (filled6 < closedSize6) {
    log.warn("trigger reduce smaller than sized; exits sized to the venue", {
      positionId: ctx.position.id,
      wanted: fromSize6(closedSize6),
      closed: fromSize6(filled6),
    });
  }

  const slices = splitClosedSize(filled6, shares);
  const confirmed: Batch = {
    ...batch,
    fillPrice18: fill18.toString(),
    holders: holders.map((h, i) => ({ ...h, closedSize: slices[i].toString() })),
  };
  const updated = await db.ledgerEntry.update({
    where: { id: entry.id },
    data: {
      venueStatus: "confirmed",
      filledSize: filled6.toString(),
      fillPrice: fill18.toString(),
      batch: confirmed as unknown as Prisma.InputJsonValue,
    },
  });

  await finishOnChain(ctx, updated);
}

/**
 * The on-chain leg of a confirmed batch: fund, then executeTrigger each holder
 * not yet done, then retire the defaults if the batch used them. A holder the
 * contract refuses because the live mark no longer breaches their level (or
 * the venue can't be read) stays not-done for the next tick.
 */
async function finishOnChain(ctx: TriggerContext, entry: LedgerEntry): Promise<void> {
  const token = ctx.positionToken;
  const batch = entry.batch as unknown as Batch | null;
  if (!batch) throw new Error(`trigger_exit entry ${entry.id} has no batch`);

  const fill18 = BigInt(batch.fillPrice18);
  const todo = batch.holders.filter((h) => !h.done);
  const balances = await Promise.all(todo.map((h) => shareBalanceOf(token, h.holder as Address)));
  const payout = (balances.reduce((sum, b) => sum + b, 0n) * (await navPerShare(token))) / PRICE_SCALE;
  await fundPayout(ctx.slot, token, payout);

  let usedDefaults = false;
  let deferred = 0;
  for (const [i, holder] of todo.entries()) {
    if (balances[i] === 0n) {
      // Already exited before a restart -- or the tokens moved on after the
      // order, in which case the venue position is now smaller than the token's size.
      log.warn("trigger holder has no balance left; skipping", { entryId: entry.id, holder: holder.holder });
      holder.done = true;
    } else {
      const result = await exitHolder(ctx, holder, fill18, entry.id);
      if (result === "deferred") {
        deferred += 1;
        continue;
      }
      if (result === "exited") usedDefaults ||= holder.usedDefault;
      holder.done = true;
    }
    await db.ledgerEntry.update({
      where: { id: entry.id },
      data: { batch: batch as unknown as Prisma.InputJsonValue },
    });
  }

  if (usedDefaults) await retireDefaults(token, ctx.position.id);
  if (deferred > 0) {
    log.warn("trigger exits deferred to the next tick", { entryId: entry.id, positionId: ctx.position.id, deferred });
    return;
  }
  await markOnchainFulfilled(entry.id);

  if (await isClosed(token)) {
    // Every share left: the token closed and settled itself at zero.
    await settleEmptiedPosition(ctx.position.id);
  } else if (BigInt(entry.filledSize ?? "0") > 0n) {
    recycleFreedMargin(ctx, payout);
  }
}

/**
 * executeTrigger for one holder. "trigger not hit" / "venue mark unavailable"
 * -> deferred (the next tick tries again); "insufficient assets" -> re-fund
 * once and retry.
 */
async function exitHolder(
  ctx: TriggerContext,
  holder: BatchHolder,
  fill18: bigint,
  entryId: string,
): Promise<"exited" | "deferred" | "failed"> {
  const call = () =>
    executeTrigger({
      positionToken: ctx.positionToken,
      holder: holder.holder as Address,
      closedSize: BigInt(holder.closedSize),
      fillPrice: fill18,
    });
  for (let attempt = 1; ; attempt += 1) {
    try {
      await call();
      return "exited";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/trigger not hit|venue mark unavailable/i.test(message)) return "deferred";
      if (attempt === 1 && /insufficient assets/i.test(message)) {
        const shares = await shareBalanceOf(ctx.positionToken, holder.holder as Address);
        await fundPayout(ctx.slot, ctx.positionToken, (shares * (await navPerShare(ctx.positionToken))) / PRICE_SCALE);
        continue;
      }
      alert("executeTrigger failed after its venue reduce; token size and venue position now differ", {
        entryId,
        positionId: ctx.position.id,
        holder: holder.holder,
        closedSize: holder.closedSize,
        ...errorFields(error),
      });
      return "failed";
    }
  }
}

/// The creator's plan has played out: later buyers no longer inherit it.
async function retireDefaults(positionToken: Address, positionId: string): Promise<void> {
  try {
    await retireDefaultTriggers(positionToken);
    log.info("default SL/TP retired", { positionId });
  } catch (error) {
    // Already retired, or the position closed with the last exit.
    log.warn("retireDefaultTriggers skipped", { positionId, ...errorFields(error) });
  }
}
