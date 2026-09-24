import type { LedgerEntry, Position, Prisma } from "@prisma/client";
import type { Address } from "viem";

import { isLongSide } from "../arcus/types";
import { publicClient } from "../chain/clients";
import { positionTokenAbi } from "../chain/abi";
import {
  applyReport,
  executeTrigger,
  getLastReport,
  isClosed,
  navPerShare,
  readPositionState,
  retireDefaultTriggers,
  shareBalanceOf,
} from "../chain/writes";
import { db } from "../config/db";
import { alert, createLogger, errorFields } from "../lib/logger";
import { PRICE_SCALE, fromPrice18, fromSize6, toPrice18, toSize6 } from "../lib/units";
import { credentialsFor, type SlotWithWallet } from "./allocator";
import { settleEmptiedPosition } from "./closePosition";
import { markOnchainFulfilled, markReversed, recordPending } from "./ledger";
import { fundPayout, recycleFreedMargin } from "./margin";
import type { ResolvedMarket } from "./markets";
import { clientIdFor, placeMarketOrder } from "./orders";
import { findLeg } from "./reporter";
import { redeemClosedSize } from "./sizing";
import { effectiveLevels, levelsHit, splitClosedSize, type Side } from "./triggerMath";

const log = createLogger("triggers");

/**
 * Per-holder stop loss / take profit, evaluated on the reporter's minute tick.
 *
 * All holders share one Arcus position, so a trigger can't be a stop order on
 * it -- that would close it for everyone. A fired trigger is an automatic
 * redeem of that one holder's wallet balance instead:
 *
 *   1. find holders whose effective level the fresh mark has crossed
 *   2. ONE reduce-only MARKET IOC order for their combined proportional size
 *   3. fund the token for Σ shares x navPerShare()
 *   4. executeTrigger(holder, slice, fill) for each -- the fill shared out by
 *      shares, the last holder taking the rounding remainder
 *   5. retireDefaultTriggers() if anyone in the batch was on the defaults
 *
 * One aggregate order is exact: each exit takes its proportional slice, so
 * after one holder leaves `size / supply` is unchanged and the next holder's
 * slice from the same snapshot is still what the contract expects.
 *
 * The contract re-checks every holder's own level against its stored mark, so
 * the operator can only ever exit someone whose level is really breached.
 *
 * Crash safety follows the ledger rule: a `trigger_exit` row is written
 * `pending` before the order, `confirmed` with the fill and the per-holder
 * split (`batch`) after it, and each executeTrigger ticks its holder `done`. A
 * confirmed batch is finished on the next tick; a pending one is never guessed
 * at -- no second order is placed until a human resolves it.
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
  /// The mark the batch was decided at, 1e18 -- re-pushed if a report lands
  /// mid-batch and moves it back across a level.
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

/**
 * Runs after the reporter has pushed the fresh mark for this position.
 * Finishes an interrupted batch first; otherwise evaluates and runs a new one.
 */
export async function processTriggers(ctx: TriggerContext): Promise<void> {
  const id = ctx.position.id;
  if (running.has(id)) return;
  running.add(id);
  try {
    // A close owns the Arcus leg from here on.
    if (await db.settlement.findUnique({ where: { positionId: id }, select: { positionId: true } })) return;

    const unfinished = await db.ledgerEntry.findFirst({
      where: { positionId: id, type: "trigger_exit", arcusStatus: { in: ["pending", "confirmed"] }, onchainFulfilledAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (unfinished) {
      if (unfinished.arcusStatus === "confirmed") {
        await finishOnChain(ctx, unfinished);
      } else if (Date.now() - unfinished.createdAt.getTime() > PENDING_STALE_MS) {
        // The order's fate is unknown; placing another could double the reduce.
        alert("trigger batch stuck in pending; triggers paused for this position", {
          entryId: unfinished.id,
          positionId: id,
          clientId: unfinished.arcusClientId,
        });
      }
      return;
    }

    await runBatch(ctx);
  } finally {
    running.delete(id);
  }
}

/// A batch confirmed on Arcus but not finished on-chain (or stuck pending).
export async function hasUnfinishedBatch(positionId: string): Promise<boolean> {
  const entry = await db.ledgerEntry.findFirst({
    where: { positionId, type: "trigger_exit", arcusStatus: { in: ["pending", "confirmed"] }, onchainFulfilledAt: null },
    select: { id: true },
  });
  return entry !== null;
}

async function runBatch(ctx: TriggerContext): Promise<void> {
  const token = ctx.positionToken;
  const state = await readPositionState(token);
  if (state.closed) return;

  // The DB narrows the list; the chain decides. Levels and balances are read
  // live against the token's stored mark -- exactly what executeTrigger checks.
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

  const shares = holders.map((h) => BigInt(h.shares));
  const exiting = shares.reduce((sum, s) => sum + s, 0n);
  const nav = await navPerShare(token);
  const credentials = credentialsFor(ctx.slot);
  const leg = await findLeg(credentials, ctx.market.arcusMarketId);

  // Σ shares / supply of the size, on the step; the whole leg for a full exit;
  // 0 below the minimum order size (then paid from the buffer alone).
  const closedSize6 = redeemClosedSize({
    shares: exiting,
    supply: state.totalSupply,
    size6: state.size,
    legSize6: leg ? toSize6(leg.size) : 0n,
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

  let filled6 = 0n;
  let fill18 = 0n;
  if (closedSize6 > 0n && leg) {
    const clientId = clientIdFor("t", token);
    await db.ledgerEntry.update({ where: { id: entry.id }, data: { arcusClientId: clientId } });
    const outcome = await placeMarketOrder({
      credentials,
      market: ctx.market,
      side: isLongSide(leg.side) ? "SELL" : "BUY",
      quantity: fromSize6(closedSize6),
      reduceOnly: true,
      clientId,
    });
    if (outcome.unfilled) {
      // Nothing moved; the holders are still breached, so the next tick retries.
      await markReversed(entry.id, `trigger order did not fill (${outcome.status}); retried next tick`);
      log.warn("trigger order did not fill", { positionId: ctx.position.id, status: outcome.status });
      return;
    }
    filled6 = toSize6(outcome.filledSize);
    fill18 = toPrice18(outcome.averagePrice);
    if (filled6 < closedSize6) {
      log.warn("trigger order partially filled; exits sized to the fill", {
        positionId: ctx.position.id,
        wanted: fromSize6(closedSize6),
        filled: outcome.filledSize,
      });
    }
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
      arcusStatus: "confirmed",
      filledSize: filled6.toString(),
      fillPrice: fill18.toString(),
      batch: confirmed as unknown as Prisma.InputJsonValue,
    },
  });

  await finishOnChain(ctx, updated);
}

/**
 * The on-chain leg of a confirmed batch: fund, then executeTrigger each holder
 * not yet done, then retire the defaults if the batch used them.
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
  for (const [i, holder] of todo.entries()) {
    if (balances[i] === 0n) {
      // Already exited before a restart -- or the tokens moved on after the
      // order, in which case the Arcus leg is now smaller than the token's size.
      log.warn("trigger holder has no balance left; skipping", { entryId: entry.id, holder: holder.holder });
    } else if (await exitHolder(ctx, batch, holder, fill18, entry.id)) {
      usedDefaults ||= holder.usedDefault;
    }
    holder.done = true;
    await db.ledgerEntry.update({
      where: { id: entry.id },
      data: { batch: batch as unknown as Prisma.InputJsonValue },
    });
  }

  if (usedDefaults) await retireDefaults(token, ctx.position.id);
  await markOnchainFulfilled(entry.id);

  if (await isClosed(token)) {
    // Every share left: the token closed and settled itself at zero.
    await settleEmptiedPosition(ctx.position.id);
  } else if (BigInt(entry.filledSize ?? "0") > 0n) {
    recycleFreedMargin(ctx, payout);
  }
}

/**
 * executeTrigger for one holder. The contract checks the level against its
 * stored mark; if a buy-in's fresh report moved it back across the level
 * mid-batch, the batch's own mark is re-reported once -- a real Arcus mark
 * from moments ago, and the one the order was placed at -- and retried.
 */
async function exitHolder(
  ctx: TriggerContext,
  batch: Batch,
  holder: BatchHolder,
  fill18: bigint,
  entryId: string,
): Promise<boolean> {
  const call = () =>
    executeTrigger({
      positionToken: ctx.positionToken,
      holder: holder.holder as Address,
      closedSize: BigInt(holder.closedSize),
      fillPrice: fill18,
    });
  try {
    await call();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/trigger not hit/i.test(message)) {
      await reReport(ctx.positionToken, BigInt(batch.mark18));
    } else if (/insufficient assets/i.test(message)) {
      const shares = await shareBalanceOf(ctx.positionToken, holder.holder as Address);
      await fundPayout(ctx.slot, ctx.positionToken, (shares * (await navPerShare(ctx.positionToken))) / PRICE_SCALE);
    } else {
      throw error;
    }
  }
  try {
    await call();
    return true;
  } catch (error) {
    alert("executeTrigger failed after its Arcus reduce; token size and Arcus leg now differ", {
      entryId,
      positionId: ctx.position.id,
      holder: holder.holder,
      closedSize: holder.closedSize,
      ...errorFields(error),
    });
    return false;
  }
}

async function reReport(positionToken: Address, mark18: bigint): Promise<void> {
  const last = await getLastReport(positionToken);
  const now = BigInt(Math.floor(Date.now() / 1000));
  await applyReport({
    positionToken,
    markPrice: mark18,
    funding: last.funding,
    timestamp: now > last.timestamp ? now : last.timestamp + 1n,
  });
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
