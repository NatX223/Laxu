import { parseAbiItem, type Address, type Log } from "viem";

import { db } from "../config/db";
import { config } from "../config/env";
import { factoryAddress, lendingPoolFactoryAddress, publicClient } from "../chain/clients";
import {
  lendingPoolAbi,
  lendingPoolFactoryAbi,
  positionTokenAbi,
  positionTokenFactoryAbi,
} from "../chain/abi";
import { startWorker } from "../lib/async";
import { createLogger, errorFields } from "../lib/logger";
import { cancelEntry, handleDepositRequested, handleRedeemRequested } from "../services/margin";
import { executeClose } from "../services/closePosition";
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
 *                         PositionClosed             -> final NAV point + status backstop
 *                         Listed                     -> positions.listed / nickname
 *                         DepositRequestCancelled /
 *                         RedeemRequestCancelled     -> ledger row cancelled, Arcus move undone
 *   LendingPoolFactory    PoolCreated                -> watch the pool
 *   LendingPool           CollateralDeposited /
 *                         Borrowed                   -> liquidation bot's watch list
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

type AnyLog = Log<bigint, number, false>;
type EventKind =
  | "deposit"
  | "redeem"
  | "close"
  | "funding"
  | "closed"
  | "listed"
  | "depositCancelled"
  | "redeemCancelled";
type LendingEventKind = "collateral" | "borrowed";

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
  };
  // A report landing in the very block of the close would share its
  // timestamp; the final values win that tie.
  await db.positionReport.upsert({
    where: { positionId_timestamp: { positionId: position.id, timestamp } },
    create: { positionId: position.id, timestamp, ...values },
    update: values,
  });

  await db.position.updateMany({
    where: { id: position.id, status: { not: "closed" } },
    data: { status: "closed", liquidated: args.wasLiquidated, closedAt: timestamp },
  });

  log.info("PositionClosed indexed", {
    positionId: position.id,
    finalNavValue: args.finalNavValue.toString(),
    wasLiquidated: args.wasLiquidated,
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
// Lending-side event handlers -- watch for borrowers to hand to the
// liquidation bot's health-check loop, nothing more. The bot itself reads
// healthFactor()/maxLiquidatableDebt() fresh on every tick; these handlers only
// ever grow the (pool, borrower) watch list, never touch balances or debt.
// ---------------------------------------------------------------------------

async function recordBorrower(poolAddress: string, borrowerAddress: string): Promise<void> {
  const pool = await db.lendingPool.findUnique({ where: { poolAddress: poolAddress.toLowerCase() } });
  if (!pool) {
    log.warn("borrower event from an unknown lending pool", { poolAddress });
    return;
  }
  await db.borrower.upsert({
    where: {
      lendingPoolId_address: { lendingPoolId: pool.id, address: borrowerAddress.toLowerCase() },
    },
    create: { lendingPoolId: pool.id, address: borrowerAddress.toLowerCase() },
    update: {},
  });
}

async function handleCollateralDeposited(entry: AnyLog): Promise<void> {
  const args = (entry as unknown as { args: { user: Address } }).args;
  await recordBorrower(entry.address, args.user);
}

async function handleBorrowed(entry: AnyLog): Promise<void> {
  const args = (entry as unknown as { args: { user: Address } }).args;
  await recordBorrower(entry.address, args.user);
}

async function dispatchLending(kind: LendingEventKind, entry: AnyLog): Promise<void> {
  try {
    if (kind === "collateral") await handleCollateralDeposited(entry);
    else await handleBorrowed(entry);
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
  // A closed position stays in the set until its final NAV point is indexed,
  // or a close executeClose recorded while the indexer was down would never
  // reach the chart.
  const rows = await db.position.findMany({
    where: {
      positionTokenAddress: { not: null },
      OR: [{ status: { not: "closed" } }, { reports: { none: { isFinal: true } } }],
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
  const [deposits, redeems, closes, fundings, closeds, listeds, depositCancels, redeemCancels] = await Promise.all([
    client.getLogs({ address: addresses, event: depositRequestedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: redeemRequestedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: closeRequestedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: fundingUpdatedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: positionClosedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: listedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: depositCancelledEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: redeemCancelledEvent, fromBlock, toBlock }),
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
  const [deposits, borrows] = await Promise.all([
    client.getLogs({ address: addresses, event: collateralDepositedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: borrowedEvent, fromBlock, toBlock }),
  ]);

  const ordered = [
    ...deposits.map((entry) => ({ kind: "collateral" as const, entry })),
    ...borrows.map((entry) => ({ kind: "borrowed" as const, entry })),
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
    unwatchFns.push(
      client.watchContractEvent({
        address,
        abi: lendingPoolAbi,
        eventName: "CollateralDeposited",
        onLogs: (logs) =>
          logs.forEach((entry) => void dispatchLending("collateral", entry as unknown as AnyLog)),
      }),
    );
    unwatchFns.push(
      client.watchContractEvent({
        address,
        abi: lendingPoolAbi,
        eventName: "Borrowed",
        onLogs: (logs) => logs.forEach((entry) => void dispatchLending("borrowed", entry as unknown as AnyLog)),
      }),
    );

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
            watchPositionToken((entry as unknown as { args: { positionToken: Address } }).args.positionToken);
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
