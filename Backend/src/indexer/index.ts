import { parseAbiItem, parseEventLogs, zeroAddress, type Address, type Log } from "viem";

import { db } from "../config/db";
import { config } from "../config/env";
import { PRICE_SCALE, factoryAddress, lendingPoolFactoryAddress, publicClient } from "../chain/clients";
import {
  lendingPoolAbi,
  lendingPoolFactoryAbi,
  positionTokenAbi,
  positionTokenFactoryAbi,
} from "../chain/abi";
import { readPositionState } from "../chain/writes";
import { fromPrice18 } from "../lib/units";
import { startWorker } from "../lib/async";
import { createLogger, errorFields } from "../lib/logger";
import { cancelEntry, handleDepositRequested, handleRedeemRequested } from "../services/margin";
import { executeClose, settleEmptiedPosition } from "../services/closePosition";
import { findEntryForLog, recordPending } from "../services/ledger";

const log = createLogger("indexer");

/**
 * On-chain event listener.
 *
 * Backfills from a durable checkpoint with `getLogs`, then switches to live
 * `watchContractEvent` subscriptions -- push delivery over the RPC's
 * WebSocket transport, no polling loop needed once live (see
 * `chain/clients.ts`'s `readTransport`).
 *
 * PositionTokens are discovered from the Factory's own `PositionCreated` log,
 * chain state rather than the DB -- if the backend's own `positions` row
 * write ever failed after `createPosition()` succeeded on-chain, this still
 * catches it. That discovery window is bounded by the checkpoint, so it's
 * unioned with whatever the DB already knows was minted, or a restart would
 * lose track of every token created before the checkpoint's current window.
 */

const CHECKPOINT_ID = 1;

/**
 * Event shapes, exactly as the contracts declare them -- `indexed` included,
 * since a wrong `indexed` flag breaks decoding even though the topic hash is
 * unchanged.
 *
 *   PositionTokenFactory  PositionCreated            -> start watching the token
 *   PositionToken         DepositRequested           -> margin add (+ fulfil)
 *                         RedeemRequested            -> proportional reduce + margin remove (+ fulfil)
 *                         CloseRequested             -> executeClose
 *                         FundingUpdated             -> PositionReport row
 *                         PositionClosed             -> provisional final NAV point + status backstop
 *                         Settled                    -> final NAV point rewritten with the recovered USDG
 *                         Claimed                    -> Flow claim
 *                         Listed                     -> positions.listed / nickname
 *                         DepositRequestCancelled /
 *                         RedeemRequestCancelled     -> ledger row cancelled, Arcus move undone
 *                         Transfer                   -> Holding balances (re-read balanceOf)
 *                         DepositFulfilled           -> Flow buy_in / top_up (+ Position mirror)
 *                         RedeemFulfilled            -> Flow redeem (+ Position mirror)
 *                         CreatorFeeCollected        -> BuyInFee, folded into its buy-in's feeAssets
 *                         TriggersSet                -> HolderTrigger upsert (custom) / delete (defaults)
 *                         TriggerExecuted            -> Flow trigger_exit; a fired personal trigger's row deleted
 *                         DefaultTriggersRetired     -> positions.defaultsActive = false
 *   LendingPoolFactory    PoolCreated                -> watch the pool
 *   LendingPool           CollateralDeposited / CollateralWithdrawn /
 *                         Borrowed / Repaid / Liquidated
 *                                                    -> Borrower row; collateral and debt re-read
 *
 * `requestId` is always 0 on PositionToken, so request, close and cancel
 * events are deduped on the emitting log's (transactionHash, logIndex), stored
 * on the ledger row they produce.
 */
const positionCreatedEvent = parseAbiItem(
  "event PositionCreated(address indexed positionToken, address indexed creator, bytes32 market, uint8 direction, uint256 leverage)",
);
const depositRequestedEvent = parseAbiItem(
  "event DepositRequested(address indexed controller, uint256 assets, uint256 requestId)",
);
const redeemRequestedEvent = parseAbiItem(
  "event RedeemRequested(address indexed controller, uint256 shares, uint256 requestId)",
);
const fundingUpdatedEvent = parseAbiItem(
  "event FundingUpdated(uint256 markPrice, int256 fundingAccrued, uint256 timestamp)",
);
/// What `close()` emits. The NAV chart's last point comes from here, so a
/// closed position's series ends exactly at `finalNavValue`.
const positionClosedEvent = parseAbiItem("event PositionClosed(uint256 finalNavValue, bool wasLiquidated)");
/// The creator's on-chain close request -- the only way a normal close starts.
const closeRequestedEvent = parseAbiItem("event CloseRequested(address indexed creator)");
const listedEvent = parseAbiItem("event Listed(string nickname)");
const depositCancelledEvent = parseAbiItem(
  "event DepositRequestCancelled(address indexed controller, uint256 assets)",
);
const redeemCancelledEvent = parseAbiItem(
  "event RedeemRequestCancelled(address indexed controller, uint256 shares)",
);
/// Metrics (holders, flows, buy-in volume) -- see services/positionStats.ts.
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const depositFulfilledEvent = parseAbiItem(
  "event DepositFulfilled(address indexed controller, uint256 assets, uint256 shares, uint256 navPerShare, uint256 addedSize, uint256 fillPrice)",
);
const redeemFulfilledEvent = parseAbiItem(
  "event RedeemFulfilled(address indexed controller, uint256 shares, uint256 assets, uint256 navPerShare, uint256 closedSize, uint256 fillPrice)",
);
const creatorFeeEvent = parseAbiItem("event CreatorFeeCollected(uint256 amount)");
/// Settlement: the USDG actually recovered from Arcus, then each holder's payout.
const settledEvent = parseAbiItem("event Settled(uint256 assets, uint256 supply)");
const claimedEvent = parseAbiItem("event Claimed(address indexed holder, uint256 shares, uint256 assets)");
/// Per-holder stop loss / take profit -- see services/triggers.ts.
const triggersSetEvent = parseAbiItem(
  "event TriggersSet(address indexed holder, uint256 stopLoss, uint256 takeProfit, bool custom)",
);
const triggerExecutedEvent = parseAbiItem(
  "event TriggerExecuted(address indexed holder, bool isStopLoss, bool usedDefault, uint256 shares, uint256 assets, uint256 markPrice)",
);
const defaultTriggersRetiredEvent = parseAbiItem("event DefaultTriggersRetired(uint256 markPrice)");

/**
 * Lending-side liquidation bot's discovery surface -- same dual-source pattern
 * as PositionToken discovery above, just one contract layer over: the factory
 * emits `PoolCreated` once per {LendingPool} clone, and each clone emits
 * `CollateralDeposited`/`Borrowed` the first time a wallet becomes a borrower
 * worth watching. `LENDING_POOL_FACTORY_ADDRESS` is optional -- unset, this
 * whole surface is skipped.
 */
const poolCreatedEvent = parseAbiItem(
  "event PoolCreated(address indexed pool, address indexed positionToken)",
);
const collateralDepositedEvent = parseAbiItem(
  "event CollateralDeposited(address indexed user, uint256 shares)",
);
const borrowedEvent = parseAbiItem("event Borrowed(address indexed user, uint256 amount)");
const collateralWithdrawnEvent = parseAbiItem("event CollateralWithdrawn(address indexed user, uint256 shares)");
const repaidEvent = parseAbiItem("event Repaid(address indexed user, uint256 principal, uint256 interest)");
const liquidatedEvent = parseAbiItem(
  "event Liquidated(address indexed liquidator, address indexed borrower, uint256 repayAmount, uint256 seizedShares)",
);

type AnyLog = Log<bigint, number, false>;
type EventKind =
  | "deposit"
  | "redeem"
  | "close"
  | "funding"
  | "closed"
  | "listed"
  | "depositCancelled"
  | "redeemCancelled"
  | "transfer"
  | "depositFulfilled"
  | "redeemFulfilled"
  | "creatorFee"
  | "settled"
  | "claimed"
  | "triggersSet"
  | "triggerExecuted"
  | "defaultsRetired";
type LendingEventKind = "collateral" | "collateralWithdrawn" | "borrowed" | "repaid" | "liquidated";

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

async function getOrCreateCheckpoint(): Promise<{ lastProcessedBlock: bigint }> {
  const existing = await db.indexerCheckpoint.findUnique({ where: { id: CHECKPOINT_ID } });
  if (existing) return existing;

  const deployBlock = BigInt(config.positionTokenFactoryDeployBlock || "0");
  const created = await db.indexerCheckpoint.create({
    data: { id: CHECKPOINT_ID, lastProcessedBlock: deployBlock },
  });
  log.info("indexer checkpoint initialised", { block: created.lastProcessedBlock.toString() });
  return created;
}

async function updateCheckpoint(block: bigint): Promise<void> {
  await db.indexerCheckpoint.upsert({
    where: { id: CHECKPOINT_ID },
    create: { id: CHECKPOINT_ID, lastProcessedBlock: block },
    update: { lastProcessedBlock: block },
  });
}

// ---------------------------------------------------------------------------
// Ordering + lookup helpers
// ---------------------------------------------------------------------------

function compareLogOrder(a: AnyLog, b: AnyLog): number {
  const blockDelta = (a.blockNumber ?? 0n) - (b.blockNumber ?? 0n);
  if (blockDelta !== 0n) return blockDelta > 0n ? 1 : -1;
  return (a.logIndex ?? 0) - (b.logIndex ?? 0);
}

async function positionFor(address: string) {
  return db.position.findUnique({ where: { positionTokenAddress: address.toLowerCase() } });
}

/// The emitting log's identity -- the dedupe key (see the event table above).
function logKey(entry: AnyLog): { txHash: string; logIndex: number; blockNumber: bigint } {
  if (!entry.transactionHash || entry.logIndex === null || entry.blockNumber === null) {
    throw new Error("log is missing transactionHash/logIndex/blockNumber (pending block?)");
  }
  return { txHash: entry.transactionHash.toLowerCase(), logIndex: entry.logIndex, blockNumber: entry.blockNumber };
}

// ---------------------------------------------------------------------------
// Event handlers -- shared by backfill (getLogs) and live (watchContractEvent)
// ---------------------------------------------------------------------------

async function handleDeposit(entry: AnyLog): Promise<void> {
  const args = (entry as unknown as {
    args: { controller: Address; assets: bigint; requestId: bigint };
  }).args;
  const position = await positionFor(entry.address);
  if (!position) {
    log.warn("DepositRequested from an unknown position token", { address: entry.address });
    return;
  }
  await handleDepositRequested({
    positionId: position.id,
    positionTokenAddress: position.positionTokenAddress as string,
    amount: args.assets,
    controller: args.controller.toLowerCase(),
    requestId: args.requestId.toString(),
    ...logKey(entry),
  });
}

async function handleRedeem(entry: AnyLog): Promise<void> {
  const args = (entry as unknown as {
    args: { controller: Address; shares: bigint; requestId: bigint };
  }).args;
  const position = await positionFor(entry.address);
  if (!position) {
    log.warn("RedeemRequested from an unknown position token", { address: entry.address });
    return;
  }
  await handleRedeemRequested({
    positionId: position.id,
    positionTokenAddress: position.positionTokenAddress as string,
    amount: args.shares,
    controller: args.controller.toLowerCase(),
    requestId: args.requestId.toString(),
    ...logKey(entry),
  });
}

async function handleClose(entry: AnyLog): Promise<void> {
  const position = await positionFor(entry.address);
  if (!position) {
    log.warn("CloseRequested from an unknown position token", { address: entry.address });
    return;
  }
  const key = logKey(entry);
  if (await findEntryForLog(key.txHash, key.logIndex)) return; // already handled
  log.info("CloseRequested", { positionId: position.id, address: entry.address });
  await executeClose(position.id, { wasLiquidated: false, event: key });
}

/// The creator opened the position to buy-ins. One-way on-chain, so this only
/// ever sets `listed`; the nickname is fixed at the same moment.
async function handleListed(entry: AnyLog): Promise<void> {
  const args = (entry as unknown as { args: { nickname: string } }).args;
  const position = await positionFor(entry.address);
  if (!position) {
    log.warn("Listed from an unknown position token", { address: entry.address });
    return;
  }
  await db.position.update({
    where: { id: position.id },
    data: { listed: true, nickname: args.nickname },
  });
  log.info("position listed", { positionId: position.id, nickname: args.nickname });
}

/**
 * The user took an unfulfilled request back after the 20-minute timeout. Mark
 * the matching ledger row cancelled and, if the Arcus margin change already
 * happened, undo it. The event itself is recorded as a `cancel` row carrying
 * its (txHash, logIndex), which is what makes a replay a no-op.
 */
async function handleCancelled(kind: "deposit" | "redeem", entry: AnyLog): Promise<void> {
  const args = (entry as unknown as { args: { controller: Address; assets?: bigint; shares?: bigint } }).args;
  const position = await positionFor(entry.address);
  if (!position) {
    log.warn("request cancelled on an unknown position token", { address: entry.address });
    return;
  }

  const key = logKey(entry);
  if (await findEntryForLog(key.txHash, key.logIndex)) return;

  const controller = args.controller.toLowerCase();
  if (kind === "deposit") {
    // The 2% fee is not refunded, but a cancelled request is not a buy-in:
    // keep its fee out of buy-in volume.
    await db.buyInFee.updateMany({
      where: { positionId: position.id, controller, flowId: null, voided: false, blockNumber: { lte: key.blockNumber } },
      data: { voided: true },
    });
  }
  const request = await db.ledgerEntry.findFirst({
    where: {
      positionId: position.id,
      type: kind === "deposit" ? "margin_add" : "margin_remove",
      controller,
      onchainFulfilledAt: null,
      arcusStatus: { in: ["pending", "confirmed"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (request) {
    await cancelEntry(request.id, `on-chain ${kind === "deposit" ? "cancelDepositRequest" : "cancelRedeemRequest"}`);
  }
  // No row yet means the request's own handler has not run; when it does, its
  // fulfil finds nothing pending, sees this cancel on-chain, and undoes itself.

  await recordPending({
    positionId: position.id,
    type: "cancel",
    amount: (args.assets ?? args.shares ?? 0n).toString(),
    controller,
    arcusStatus: "cancelled",
    txHash: key.txHash,
    logIndex: key.logIndex,
    note: `${kind} request cancelled on-chain${request ? ` (entry ${request.id})` : ""}`,
  });
}

/**
 * The contract's own view reads as of the event's block -- read rather than
 * recomputed so the NAV chart can never drift from the contract's accounting.
 *
 * Historical reads need the RPC to still hold that block's state. Live events
 * are recent enough for any node; a backfill against a non-archive RPC may
 * not be, and then this falls back to `latest`. That leaves an old point
 * slightly off -- fine for a chart, and nothing else reads these columns.
 */
async function readAtBlock<const F extends "totalAssets" | "totalSupply" | "markPrice" | "fundingAccrued">(
  address: Address,
  blockNumber: bigint | null,
  functionNames: readonly F[],
): Promise<bigint[]> {
  const client = publicClient();
  const read = (at?: bigint) =>
    Promise.all(
      functionNames.map(
        (functionName) =>
          client.readContract({
            address,
            abi: positionTokenAbi,
            functionName,
            blockNumber: at,
          }) as Promise<bigint>,
      ),
    );

  if (blockNumber !== null) {
    try {
      return await read(blockNumber);
    } catch (error) {
      log.warn("historical read failed; falling back to latest", {
        address,
        blockNumber: blockNumber.toString(),
        ...errorFields(error),
      });
    }
  }
  return read();
}

/// Writes a PositionReport row -- what the NAV chart plots. The
/// `@@unique([positionId, timestamp])` constraint is the dedupe guard: a
/// re-delivered or re-backfilled event just no-ops on the upsert.
async function handleFunding(entry: AnyLog): Promise<void> {
  const args = (entry as unknown as {
    args: { markPrice: bigint; fundingAccrued: bigint; timestamp: bigint };
  }).args;
  const position = await positionFor(entry.address);
  if (!position) {
    log.warn("FundingUpdated from an unknown position token", { address: entry.address });
    return;
  }

  const timestamp = new Date(Number(args.timestamp) * 1000);
  // Skip the two RPC reads for a report already on file (re-backfill).
  const existing = await db.positionReport.findUnique({
    where: { positionId_timestamp: { positionId: position.id, timestamp } },
    select: { id: true },
  });
  if (existing) return;

  const [totalAssets, totalSupply] = await readAtBlock(entry.address, entry.blockNumber, [
    "totalAssets",
    "totalSupply",
  ]);
  await db.positionReport.upsert({
    where: { positionId_timestamp: { positionId: position.id, timestamp } },
    create: {
      positionId: position.id,
      markPrice: args.markPrice.toString(),
      funding: args.fundingAccrued.toString(),
      totalAssets: totalAssets.toString(),
      totalSupply: totalSupply.toString(),
      timestamp,
    },
    update: {},
  });
  // The mirror only moves forward: a backfilled older report must not
  // overwrite a newer one.
  const latest = await db.positionReport.findFirst({
    where: { positionId: position.id },
    orderBy: { timestamp: "desc" },
    select: { timestamp: true },
  });
  if (latest && latest.timestamp.getTime() === timestamp.getTime()) {
    await db.position.update({
      where: { id: position.id },
      data: { markPrice: args.markPrice.toString(), fundingAccrued: args.fundingAccrued.toString() },
    });
  }
}

// ---------------------------------------------------------------------------
// Metrics: holders, flows, fees
// ---------------------------------------------------------------------------

const blockTimes = new Map<bigint, Date>();

async function blockTime(blockNumber: bigint | null): Promise<Date> {
  if (blockNumber === null) return new Date();
  const cached = blockTimes.get(blockNumber);
  if (cached) return cached;
  const block = await publicClient().getBlock({ blockNumber });
  const time = new Date(Number(block.timestamp) * 1000);
  if (blockTimes.size > 2_000) blockTimes.clear();
  blockTimes.set(blockNumber, time);
  return time;
}

/// Balances are re-read rather than applied as deltas, so a replayed or
/// out-of-order Transfer can never double-count.
async function handleTransfer(entry: AnyLog): Promise<void> {
  const args = (entry as unknown as { args: { from: Address; to: Address } }).args;
  const position = await positionFor(entry.address);
  if (!position) return;
  for (const holder of [args.from, args.to]) {
    if (holder.toLowerCase() === zeroAddress) continue;
    const balance = (await publicClient().readContract({
      address: entry.address,
      abi: positionTokenAbi,
      functionName: "balanceOf",
      args: [holder],
    })) as bigint;
    const address = holder.toLowerCase();
    await db.holding.upsert({
      where: { positionId_address: { positionId: position.id, address } },
      create: { positionId: position.id, address, balance: balance.toString() },
      update: { balance: balance.toString() },
    });
  }
}

/// Size, entry, capital and settled funding move on every fulfil; re-read them.
async function refreshPositionMirror(positionId: string, token: Address): Promise<void> {
  const state = await readPositionState(token);
  await db.position.update({
    where: { id: positionId },
    data: {
      size: state.size.toString(),
      entryPrice: state.entryPrice.toString(),
      capital: state.capital.toString(),
      fundingSettled: state.fundingSettled.toString(),
    },
  });
}

/// Fold every unattached, un-voided fee this controller paid up to `upToBlock`
/// into the flow -- the library sums a controller's requests into one fulfil.
async function attachFees(positionId: string, controller: string, flowId: string, upToBlock: bigint): Promise<void> {
  const fees = await db.buyInFee.findMany({
    where: { positionId, controller, flowId: null, voided: false, blockNumber: { lte: upToBlock } },
  });
  if (fees.length === 0) return;
  const flow = await db.flow.findUniqueOrThrow({ where: { id: flowId } });
  const total = fees.reduce((sum, fee) => sum + BigInt(fee.amount), BigInt(flow.feeAssets));
  await db.$transaction([
    db.flow.update({ where: { id: flowId }, data: { feeAssets: total.toString() } }),
    db.buyInFee.updateMany({ where: { id: { in: fees.map((f) => f.id) } }, data: { flowId } }),
  ]);
}

async function recordFlow(
  entry: AnyLog,
  data: { type: string; address: string; assets: bigint; shares: bigint; navPerShare: bigint; trigger?: string },
): Promise<{ id: string; positionId: string } | null> {
  const position = await positionFor(entry.address);
  if (!position) return null;
  const key = logKey(entry);
  const flow = await db.flow.upsert({
    where: { txHash_logIndex: { txHash: key.txHash, logIndex: key.logIndex } },
    create: {
      positionId: position.id,
      type: data.type,
      address: data.address.toLowerCase(),
      assets: data.assets.toString(),
      shares: data.shares.toString(),
      navPerShare: data.navPerShare.toString(),
      trigger: data.trigger ?? null,
      txHash: key.txHash,
      logIndex: key.logIndex,
      timestamp: await blockTime(entry.blockNumber),
    },
    update: {},
  });
  await refreshPositionMirror(position.id, entry.address);
  return { id: flow.id, positionId: position.id };
}

async function handleDepositFulfilled(entry: AnyLog): Promise<void> {
  const args = (entry as unknown as {
    args: { controller: Address; assets: bigint; shares: bigint; navPerShare: bigint };
  }).args;
  const position = await positionFor(entry.address);
  if (!position) return;
  const controller = args.controller.toLowerCase();
  const flow = await recordFlow(entry, {
    // The creator adding to their own position is a top-up, not a buy-in.
    type: controller === position.userWalletAddress.toLowerCase() ? "top_up" : "buy_in",
    address: controller,
    assets: args.assets,
    shares: args.shares,
    navPerShare: args.navPerShare,
  });
  if (flow) await attachFees(flow.positionId, controller, flow.id, logKey(entry).blockNumber);
}

async function handleRedeemFulfilled(entry: AnyLog): Promise<void> {
  const args = (entry as unknown as {
    args: { controller: Address; shares: bigint; assets: bigint; navPerShare: bigint };
  }).args;
  await recordFlow(entry, {
    type: "redeem",
    address: args.controller,
    assets: args.assets,
    shares: args.shares,
    navPerShare: args.navPerShare,
  });
}

/// A holder's own levels (custom), or back to the defaults (row deleted). An
/// explicit "none" is a custom row with both levels null.
async function handleTriggersSet(entry: AnyLog): Promise<void> {
  const args = (entry as unknown as {
    args: { holder: Address; stopLoss: bigint; takeProfit: bigint; custom: boolean };
  }).args;
  const position = await positionFor(entry.address);
  if (!position) return;
  const holder = args.holder.toLowerCase();
  if (!args.custom) {
    await db.holderTrigger.deleteMany({ where: { positionId: position.id, holder } });
    return;
  }
  const levels = {
    stopLoss: args.stopLoss > 0n ? fromPrice18(args.stopLoss) : null,
    takeProfit: args.takeProfit > 0n ? fromPrice18(args.takeProfit) : null,
  };
  await db.holderTrigger.upsert({
    where: { positionId_holder: { positionId: position.id, holder } },
    create: { positionId: position.id, holder, ...levels },
    update: levels,
  });
}

/// An SL/TP exit: priced at NAV like a redeem. A personal trigger fires once.
async function handleTriggerExecuted(entry: AnyLog): Promise<void> {
  const args = (entry as unknown as {
    args: { holder: Address; isStopLoss: boolean; usedDefault: boolean; shares: bigint; assets: bigint };
  }).args;
  const flow = await recordFlow(entry, {
    type: "trigger_exit",
    address: args.holder,
    assets: args.assets,
    shares: args.shares,
    navPerShare: args.shares > 0n ? (args.assets * PRICE_SCALE) / args.shares : 0n,
    trigger: args.isStopLoss ? "stop_loss" : "take_profit",
  });
  if (flow && !args.usedDefault) {
    await db.holderTrigger.deleteMany({ where: { positionId: flow.positionId, holder: args.holder.toLowerCase() } });
  }
}

async function handleDefaultsRetired(entry: AnyLog): Promise<void> {
  const position = await positionFor(entry.address);
  if (!position) return;
  await db.position.update({ where: { id: position.id }, data: { defaultsActive: false } });
}

/**
 * The fee is taken at requestDeposit, before the buy-in's Flow exists. The
 * event carries no controller, so it comes from the DepositRequested in the
 * same transaction. Held as a BuyInFee until the fulfil folds it in.
 */
async function handleCreatorFee(entry: AnyLog): Promise<void> {
  const args = (entry as unknown as { args: { amount: bigint } }).args;
  const position = await positionFor(entry.address);
  if (!position) return;
  const key = logKey(entry);

  const receipt = await publicClient().getTransactionReceipt({ hash: key.txHash as `0x${string}` });
  const request = parseEventLogs({ abi: [depositRequestedEvent], logs: receipt.logs, eventName: "DepositRequested" }).find(
    (item) => item.address.toLowerCase() === entry.address.toLowerCase(),
  );
  if (!request) {
    log.warn("CreatorFeeCollected with no DepositRequested in the same tx", { txHash: key.txHash });
    return;
  }
  const controller = request.args.controller.toLowerCase();

  await db.buyInFee.upsert({
    where: { txHash_logIndex: { txHash: key.txHash, logIndex: key.logIndex } },
    create: {
      positionId: position.id,
      controller,
      amount: args.amount.toString(),
      txHash: key.txHash,
      logIndex: key.logIndex,
      blockNumber: key.blockNumber,
    },
    update: {},
  });

  // Normally the fulfil comes minutes later and attaches it. If its Flow is
  // already on file (live subscriptions can deliver out of order), attach now.
  const later = await db.flow.findFirst({
    where: {
      positionId: position.id,
      address: controller,
      type: "buy_in",
      timestamp: { gte: await blockTime(key.blockNumber) },
    },
    orderBy: { timestamp: "asc" },
  });
  if (later) await attachFees(position.id, controller, later.id, key.blockNumber);
}

/**
 * The NAV series' last point. `close()` pins totalAssets() at
 * `finalNavValue`, so that comes straight off the event; supply, mark and
 * funding are read at the same block (close() stores the final mark/funding
 * before emitting, and none of the three move again afterwards, so the
 * `latest` fallback is exact here). Timestamped with the block, the same
 * value close() writes into `lastReportTimestamp`.
 *
 * Also a backstop for the position's own status: executeClose and the
 * liquidation flow normally set `closed`/`liquidated` first, so these are only
 * written when not already set.
 */
async function handleClosed(entry: AnyLog): Promise<void> {
  const args = (entry as unknown as { args: { finalNavValue: bigint; wasLiquidated: boolean } }).args;
  const position = await positionFor(entry.address);
  if (!position) {
    log.warn("PositionClosed from an unknown position token", { address: entry.address });
    return;
  }

  const block = await publicClient().getBlock(
    entry.blockNumber !== null ? { blockNumber: entry.blockNumber } : {},
  );
  const timestamp = new Date(Number(block.timestamp) * 1000);
  const [totalSupply, markPrice, funding] = await readAtBlock(entry.address, entry.blockNumber, [
    "totalSupply",
    "markPrice",
    "fundingAccrued",
  ]);

  const values = {
    markPrice: markPrice.toString(),
    funding: funding.toString(),
    totalAssets: args.finalNavValue.toString(),
    totalSupply: totalSupply.toString(),
    isFinal: true,
    // The formula estimate; Settled replaces it with what Arcus returned.
    provisional: true,
  };
  // A report landing in the very block of the close would share its
  // timestamp; the final values win that tie. Never downgrade a point a
  // Settled event already rewrote (re-backfill).
  const existing = await db.positionReport.findUnique({
    where: { positionId_timestamp: { positionId: position.id, timestamp } },
    select: { isFinal: true, provisional: true },
  });
  if (!(existing?.isFinal && !existing.provisional)) {
    await db.positionReport.upsert({
      where: { positionId_timestamp: { positionId: position.id, timestamp } },
      create: { positionId: position.id, timestamp, ...values },
      update: values,
    });
  }

  await db.position.updateMany({
    where: { id: position.id, status: "open" },
    data: { status: "closed", liquidated: args.wasLiquidated, closedAt: timestamp },
  });

  log.info("PositionClosed indexed", {
    positionId: position.id,
    finalNavValue: args.finalNavValue.toString(),
    wasLiquidated: args.wasLiquidated,
  });
}

/**
 * The recovered USDG is recorded: the NAV series' last point becomes
 * `assets / supply` (replacing PositionClosed's provisional estimate), and the
 * position is settled. The backend's own settlement flow normally sets the
 * status first; this is the backstop.
 */
async function handleSettled(entry: AnyLog): Promise<void> {
  const args = (entry as unknown as { args: { assets: bigint; supply: bigint } }).args;
  const position = await positionFor(entry.address);
  if (!position) {
    log.warn("Settled from an unknown position token", { address: entry.address });
    return;
  }

  const final = await db.positionReport.findFirst({
    where: { positionId: position.id, isFinal: true },
    orderBy: { timestamp: "desc" },
  });
  if (final) {
    await db.positionReport.update({
      where: { id: final.id },
      data: { totalAssets: args.assets.toString(), totalSupply: args.supply.toString(), provisional: false },
    });
  } else {
    // PositionClosed not indexed (yet): write the final point from here.
    const [markPrice, funding] = await readAtBlock(entry.address, entry.blockNumber, ["markPrice", "fundingAccrued"]);
    const timestamp = await blockTime(entry.blockNumber);
    await db.positionReport.upsert({
      where: { positionId_timestamp: { positionId: position.id, timestamp } },
      create: {
        positionId: position.id,
        timestamp,
        markPrice: markPrice.toString(),
        funding: funding.toString(),
        totalAssets: args.assets.toString(),
        totalSupply: args.supply.toString(),
        isFinal: true,
      },
      update: {},
    });
  }

  // No settlements row: the last share left (SL/TP or redeem) and the token
  // closed and settled itself. The backend still has to recover the float and
  // free the slot -- settleEmptiedPosition does, then marks the position settled.
  const emptied = !(await db.settlement.findUnique({ where: { positionId: position.id }, select: { positionId: true } }));
  if (emptied) {
    void settleEmptiedPosition(position.id).catch((error) =>
      log.error("settling an emptied position failed; the resume job retries", {
        positionId: position.id,
        ...errorFields(error),
      }),
    );
  } else {
    await db.position.updateMany({
      where: { id: position.id, status: { not: "settled" } },
      data: { status: "settled", closedAt: position.closedAt ?? (await blockTime(entry.blockNumber)) },
    });
  }
  log.info("Settled indexed", { positionId: position.id, assets: args.assets.toString(), supply: args.supply.toString() });
}

/// A holder's payout. Holdings follow from the burn's own Transfer.
async function handleClaimed(entry: AnyLog): Promise<void> {
  const args = (entry as unknown as { args: { holder: Address; shares: bigint; assets: bigint } }).args;
  const position = await positionFor(entry.address);
  if (!position) return;
  const key = logKey(entry);
  await db.flow.upsert({
    where: { txHash_logIndex: { txHash: key.txHash, logIndex: key.logIndex } },
    create: {
      positionId: position.id,
      type: "claim",
      address: args.holder.toLowerCase(),
      assets: args.assets.toString(),
      shares: args.shares.toString(),
      // assets / shares: the settlement rate this holder was paid at.
      navPerShare: args.shares > 0n ? ((args.assets * PRICE_SCALE) / args.shares).toString() : "0",
      txHash: key.txHash,
      logIndex: key.logIndex,
      timestamp: await blockTime(entry.blockNumber),
    },
    update: {},
  });
}

async function dispatch(kind: EventKind, entry: AnyLog): Promise<void> {
  try {
    if (kind === "deposit") await handleDeposit(entry);
    else if (kind === "redeem") await handleRedeem(entry);
    else if (kind === "close") await handleClose(entry);
    else if (kind === "closed") await handleClosed(entry);
    else if (kind === "listed") await handleListed(entry);
    else if (kind === "depositCancelled") await handleCancelled("deposit", entry);
    else if (kind === "redeemCancelled") await handleCancelled("redeem", entry);
    else if (kind === "transfer") await handleTransfer(entry);
    else if (kind === "depositFulfilled") await handleDepositFulfilled(entry);
    else if (kind === "redeemFulfilled") await handleRedeemFulfilled(entry);
    else if (kind === "creatorFee") await handleCreatorFee(entry);
    else if (kind === "settled") await handleSettled(entry);
    else if (kind === "claimed") await handleClaimed(entry);
    else if (kind === "triggersSet") await handleTriggersSet(entry);
    else if (kind === "triggerExecuted") await handleTriggerExecuted(entry);
    else if (kind === "defaultsRetired") await handleDefaultsRetired(entry);
    else await handleFunding(entry);
  } catch (error) {
    log.error("event handler failed", {
      kind,
      address: entry.address,
      txHash: entry.transactionHash,
      ...errorFields(error),
    });
    // Swallow rather than propagate: the reconciler owns retry for anything
    // left half-done, and one bad event should not wedge the rest of a batch
    // or a live subscription callback.
  }
}

// ---------------------------------------------------------------------------
// Lending-side event handlers -- the liquidation bot's (pool, borrower) watch
// list, plus each borrower's collateral and debt for the metrics (holders
// include posted collateral; "Collateralized" means someone owes). Values are
// re-read from the pool, never applied as deltas, so replays are harmless.
// ---------------------------------------------------------------------------

async function recordBorrower(poolAddress: string, borrowerAddress: string): Promise<void> {
  const pool = await db.lendingPool.findUnique({ where: { poolAddress: poolAddress.toLowerCase() } });
  if (!pool) {
    log.warn("borrower event from an unknown lending pool", { poolAddress });
    return;
  }
  const user = borrowerAddress as Address;
  const read = (functionName: "collateralBalance" | "currentDebt") =>
    publicClient().readContract({
      address: poolAddress as Address,
      abi: lendingPoolAbi,
      functionName,
      args: [user],
    }) as Promise<bigint>;
  const [collateral, debt] = await Promise.all([read("collateralBalance"), read("currentDebt")]);
  const values = { collateralShares: collateral.toString(), debt: debt.toString() };
  await db.borrower.upsert({
    where: {
      lendingPoolId_address: { lendingPoolId: pool.id, address: borrowerAddress.toLowerCase() },
    },
    create: { lendingPoolId: pool.id, address: borrowerAddress.toLowerCase(), ...values },
    update: values,
  });
}

async function dispatchLending(kind: LendingEventKind, entry: AnyLog): Promise<void> {
  try {
    const args = (entry as unknown as { args: { user?: Address; borrower?: Address } }).args;
    const who = kind === "liquidated" ? args.borrower : args.user;
    if (who) await recordBorrower(entry.address, who);
  } catch (error) {
    log.error("lending event handler failed", {
      kind,
      address: entry.address,
      txHash: entry.transactionHash,
      ...errorFields(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Discovery + backfill
// ---------------------------------------------------------------------------

async function discoverAddresses(fromBlock: bigint, toBlock: bigint): Promise<Set<Address>> {
  const known = new Set<Address>();

  if (fromBlock <= toBlock) {
    const logs = await publicClient().getLogs({
      address: factoryAddress(),
      event: positionCreatedEvent,
      fromBlock,
      toBlock,
    });
    for (const entry of logs) {
      const args = (entry as unknown as { args: { positionToken: Address } }).args;
      known.add(args.positionToken.toLowerCase() as Address);
    }
  }

  // Chain state is the discovery source of truth, but the factory-log window
  // above is bounded by the checkpoint -- fold in whatever the DB already
  // knows was minted so a restart doesn't drop tokens created earlier.
  // A closed position stays in the set until it is settled and its final NAV
  // point is indexed, or a close recorded while the indexer was down would
  // never reach the chart; a settled one while anyone still holds shares, so
  // the claim burns and Claimed flows are still indexed.
  const rows = await db.position.findMany({
    where: {
      positionTokenAddress: { not: null },
      OR: [
        { status: { not: "settled" } },
        { reports: { none: { isFinal: true, provisional: false } } },
        { holdings: { some: { balance: { not: "0" } } } },
      ],
    },
    select: { positionTokenAddress: true },
  });
  for (const row of rows) {
    known.add((row.positionTokenAddress as string).toLowerCase() as Address);
  }

  return known;
}

async function backfillPositionTokenEvents(
  addresses: Address[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<void> {
  if (addresses.length === 0 || fromBlock > toBlock) return;

  const client = publicClient();
  const [
    deposits,
    redeems,
    closes,
    fundings,
    closeds,
    listeds,
    depositCancels,
    redeemCancels,
    transfers,
    depositFulfils,
    redeemFulfils,
    fees,
    settleds,
    claims,
    triggerSets,
    triggerExecs,
    defaultRetires,
  ] = await Promise.all([
    client.getLogs({ address: addresses, event: depositRequestedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: redeemRequestedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: closeRequestedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: fundingUpdatedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: positionClosedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: listedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: depositCancelledEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: redeemCancelledEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: transferEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: depositFulfilledEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: redeemFulfilledEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: creatorFeeEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: settledEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: claimedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: triggersSetEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: triggerExecutedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: defaultTriggersRetiredEvent, fromBlock, toBlock }),
  ]);

  // Process in chain order so, e.g., a deposit and a funding update in the
  // same range land in the order they actually happened.
  const ordered = [
    ...deposits.map((entry) => ({ kind: "deposit" as const, entry })),
    ...redeems.map((entry) => ({ kind: "redeem" as const, entry })),
    ...closes.map((entry) => ({ kind: "close" as const, entry })),
    ...fundings.map((entry) => ({ kind: "funding" as const, entry })),
    ...closeds.map((entry) => ({ kind: "closed" as const, entry })),
    ...listeds.map((entry) => ({ kind: "listed" as const, entry })),
    ...depositCancels.map((entry) => ({ kind: "depositCancelled" as const, entry })),
    ...redeemCancels.map((entry) => ({ kind: "redeemCancelled" as const, entry })),
    ...transfers.map((entry) => ({ kind: "transfer" as const, entry })),
    ...depositFulfils.map((entry) => ({ kind: "depositFulfilled" as const, entry })),
    ...redeemFulfils.map((entry) => ({ kind: "redeemFulfilled" as const, entry })),
    ...fees.map((entry) => ({ kind: "creatorFee" as const, entry })),
    ...settleds.map((entry) => ({ kind: "settled" as const, entry })),
    ...claims.map((entry) => ({ kind: "claimed" as const, entry })),
    ...triggerSets.map((entry) => ({ kind: "triggersSet" as const, entry })),
    ...triggerExecs.map((entry) => ({ kind: "triggerExecuted" as const, entry })),
    ...defaultRetires.map((entry) => ({ kind: "defaultsRetired" as const, entry })),
  ].sort((a, b) => compareLogOrder(a.entry as AnyLog, b.entry as AnyLog));

  for (const item of ordered) {
    await dispatch(item.kind, item.entry as unknown as AnyLog);
  }

  log.info("backfilled position token events", {
    addresses: addresses.length,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    events: ordered.length,
  });
}

/// Same dual-source shape as {discoverAddresses}: factory logs for the
/// checkpoint's window, unioned with every pool the DB already knows about so
/// a restart never drops one discovered before that window. Also upserts a
/// `LendingPool` row for anything the factory logs turn up, since that's the
/// only place `positionTokenAddress` comes from.
async function discoverPools(fromBlock: bigint, toBlock: bigint): Promise<Set<Address>> {
  const known = new Set<Address>();

  if (fromBlock <= toBlock) {
    const logs = await publicClient().getLogs({
      address: lendingPoolFactoryAddress(),
      event: poolCreatedEvent,
      fromBlock,
      toBlock,
    });
    for (const entry of logs) {
      const args = (entry as unknown as { args: { pool: Address; positionToken: Address } }).args;
      const poolAddress = args.pool.toLowerCase() as Address;
      known.add(poolAddress);
      await db.lendingPool.upsert({
        where: { poolAddress },
        create: { poolAddress, positionTokenAddress: args.positionToken.toLowerCase() },
        update: {},
      });
    }
  }

  const rows = await db.lendingPool.findMany({ select: { poolAddress: true } });
  for (const row of rows) known.add(row.poolAddress.toLowerCase() as Address);

  return known;
}

async function backfillPoolEvents(addresses: Address[], fromBlock: bigint, toBlock: bigint): Promise<void> {
  if (addresses.length === 0 || fromBlock > toBlock) return;

  const client = publicClient();
  const [deposits, withdrawals, borrows, repays, liquidations] = await Promise.all([
    client.getLogs({ address: addresses, event: collateralDepositedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: collateralWithdrawnEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: borrowedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: repaidEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: liquidatedEvent, fromBlock, toBlock }),
  ]);

  const tag = (kind: LendingEventKind) => (entry: unknown) => ({ kind, entry: entry as AnyLog });
  const ordered = [
    ...deposits.map(tag("collateral")),
    ...withdrawals.map(tag("collateralWithdrawn")),
    ...borrows.map(tag("borrowed")),
    ...repays.map(tag("repaid")),
    ...liquidations.map(tag("liquidated")),
  ].sort((a, b) => compareLogOrder(a.entry, b.entry));

  for (const item of ordered) {
    await dispatchLending(item.kind, item.entry);
  }

  log.info("backfilled lending pool events", {
    addresses: addresses.length,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    events: ordered.length,
  });
}

// ---------------------------------------------------------------------------
// Startup: backfill, then go live
// ---------------------------------------------------------------------------

export function startIndexer(): () => void {
  let stopped = false;
  const watched = new Set<string>();
  const unwatchFns: Array<() => void> = [];

  function watchPositionToken(address: Address): void {
    const key = address.toLowerCase();
    if (stopped || watched.has(key)) return;
    watched.add(key);

    const client = publicClient();
    const events: Array<[
      (
        | "DepositRequested"
        | "RedeemRequested"
        | "CloseRequested"
        | "FundingUpdated"
        | "PositionClosed"
        | "Listed"
        | "DepositRequestCancelled"
        | "RedeemRequestCancelled"
        | "Transfer"
        | "DepositFulfilled"
        | "RedeemFulfilled"
        | "CreatorFeeCollected"
        | "Settled"
        | "Claimed"
        | "TriggersSet"
        | "TriggerExecuted"
        | "DefaultTriggersRetired"
      ),
      EventKind,
    ]> = [
      ["DepositRequested", "deposit"],
      ["RedeemRequested", "redeem"],
      ["CloseRequested", "close"],
      ["FundingUpdated", "funding"],
      ["PositionClosed", "closed"],
      ["Listed", "listed"],
      ["DepositRequestCancelled", "depositCancelled"],
      ["RedeemRequestCancelled", "redeemCancelled"],
      ["Transfer", "transfer"],
      ["DepositFulfilled", "depositFulfilled"],
      ["RedeemFulfilled", "redeemFulfilled"],
      ["CreatorFeeCollected", "creatorFee"],
      ["Settled", "settled"],
      ["Claimed", "claimed"],
      ["TriggersSet", "triggersSet"],
      ["TriggerExecuted", "triggerExecuted"],
      ["DefaultTriggersRetired", "defaultsRetired"],
    ];
    for (const [eventName, kind] of events) {
      unwatchFns.push(
        client.watchContractEvent({
          address,
          abi: positionTokenAbi,
          eventName,
          onLogs: (logs) => logs.forEach((entry) => void dispatch(kind, entry as unknown as AnyLog)),
        }),
      );
    }

    log.debug("watching position token", { address: key });
  }

  function watchPool(address: Address): void {
    const key = address.toLowerCase();
    if (stopped || watched.has(key)) return;
    watched.add(key);

    const client = publicClient();
    const events: Array<
      ["CollateralDeposited" | "CollateralWithdrawn" | "Borrowed" | "Repaid" | "Liquidated", LendingEventKind]
    > = [
      ["CollateralDeposited", "collateral"],
      ["CollateralWithdrawn", "collateralWithdrawn"],
      ["Borrowed", "borrowed"],
      ["Repaid", "repaid"],
      ["Liquidated", "liquidated"],
    ];
    for (const [eventName, kind] of events) {
      unwatchFns.push(
        client.watchContractEvent({
          address,
          abi: lendingPoolAbi,
          eventName,
          onLogs: (logs) => logs.forEach((entry) => void dispatchLending(kind, entry as unknown as AnyLog)),
        }),
      );
    }

    log.debug("watching lending pool", { address: key });
  }

  async function bootstrap(): Promise<void> {
    const client = publicClient();
    const checkpoint = await getOrCreateCheckpoint();
    const latestBlock = await client.getBlockNumber();

    const fromBlock = checkpoint.lastProcessedBlock > 0n
      ? checkpoint.lastProcessedBlock + 1n
      : checkpoint.lastProcessedBlock;

    const known = await discoverAddresses(fromBlock, latestBlock);
    await backfillPositionTokenEvents(Array.from(known), fromBlock, latestBlock);
    await updateCheckpoint(latestBlock);

    if (stopped) return;

    // Go live: watch the factory for new positions, and every known token.
    unwatchFns.push(
      client.watchContractEvent({
        address: factoryAddress(),
        abi: positionTokenFactoryAbi,
        eventName: "PositionCreated",
        onLogs: (logs) => {
          for (const entry of logs) {
            const token = (entry as unknown as { args: { positionToken: Address } }).args.positionToken;
            // The genesis mint's Transfer is in the creation block itself --
            // before any subscription on the token could exist -- so catch the
            // token up from that block first. Handlers are idempotent, so any
            // overlap with the live watch is harmless.
            const from = entry.blockNumber ?? 0n;
            void client
              .getBlockNumber()
              .then((to) => backfillPositionTokenEvents([token], from, to))
              .catch((error) => log.error("new-token catch-up failed", { token, ...errorFields(error) }))
              .finally(() => watchPositionToken(token));
          }
        },
      }),
    );

    known.forEach(watchPositionToken);

    // Lending-side liquidation bot's discovery surface. LENDING_POOL_FACTORY_ADDRESS
    // is optional here -- skipped entirely when unset.
    let watchedPools = 0;
    if (config.lendingPoolFactoryAddress) {
      const knownPools = await discoverPools(fromBlock, latestBlock);
      await backfillPoolEvents(Array.from(knownPools), fromBlock, latestBlock);

      if (!stopped) {
        unwatchFns.push(
          client.watchContractEvent({
            address: lendingPoolFactoryAddress(),
            abi: lendingPoolFactoryAbi,
            eventName: "PoolCreated",
            onLogs: (logs) => {
              for (const entry of logs) {
                const pool = entry.args.pool as Address;
                const positionToken = entry.args.positionToken as Address;
                void db.lendingPool
                  .upsert({
                    where: { poolAddress: pool.toLowerCase() },
                    create: { poolAddress: pool.toLowerCase(), positionTokenAddress: positionToken.toLowerCase() },
                    update: {},
                  })
                  .then(() => watchPool(pool));
              }
            },
          }),
        );

        knownPools.forEach(watchPool);
      }
      watchedPools = knownPools.size;
    }

    log.info("indexer live", {
      watched: known.size,
      watchedPools,
      atBlock: latestBlock.toString(),
    });
  }

  void bootstrap().catch((error) => {
    log.error("indexer bootstrap failed", errorFields(error));
  });

  // Not required for correctness once live watching has taken over -- the
  // idempotency guards above handle overlap safely -- but it keeps a
  // restart's backfill window small instead of re-scanning from the factory's
  // deploy block every time.
  const stopCheckpointWorker = startWorker(
    "indexer-checkpoint",
    config.indexerCheckpointIntervalMs,
    async () => {
      const latest = await publicClient().getBlockNumber();
      await updateCheckpoint(latest);
    },
    (error) => log.error("checkpoint update failed", errorFields(error)),
  );

  return () => {
    stopped = true;
    stopCheckpointWorker();
    for (const unwatch of unwatchFns.splice(0)) unwatch();
  };
}

export { positionTokenAbi };
