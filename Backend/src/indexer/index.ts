import { parseAbiItem, type Address, type Log } from "viem";

import { db } from "../config/db";
import { config } from "../config/env";
import { factoryAddress, publicClient } from "../chain/clients";
import { closeRequestAbi, positionTokenAbi, positionTokenFactoryAbi } from "../chain/abi";
import { startWorker } from "../lib/async";
import { createLogger, errorFields } from "../lib/logger";
import { handleDepositRequested, handleRedeemRequested } from "../services/margin";
import { executeClose } from "../services/closePosition";

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

const positionCreatedEvent = parseAbiItem(
  "event PositionCreated(address indexed positionToken, address indexed creator, bytes32 indexed market, uint8 direction, uint256 leverage)",
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
/**
 * NOT YET DEPLOYED. `requestClose()` and `CloseRequested` come from the
 * close-access-control spec and do not exist on the current PositionToken, so
 * this filter matches nothing today. Watching for it costs nothing against a
 * contract that never emits it, and means the event-driven close path lights
 * up the day it ships; until then `POST /positions/:id/close` drives the same
 * `executeClose` orchestration directly.
 */
const closeRequestedEvent = parseAbiItem("event CloseRequested(address indexed creator)");

type AnyLog = Log<bigint, number, false>;
type EventKind = "deposit" | "redeem" | "close" | "funding";

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
  });
}

async function handleClose(entry: AnyLog): Promise<void> {
  const position = await positionFor(entry.address);
  if (!position) {
    log.warn("CloseRequested from an unknown position token", { address: entry.address });
    return;
  }
  log.info("CloseRequested", { positionId: position.id, address: entry.address });
  await executeClose(position.id, { wasLiquidated: false });
}

/// Writes a PositionReport row -- what the NAV chart replays. The
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
  await db.positionReport.upsert({
    where: { positionId_timestamp: { positionId: position.id, timestamp } },
    create: {
      positionId: position.id,
      markPrice: args.markPrice.toString(),
      funding: args.fundingAccrued.toString(),
      timestamp,
    },
    update: {},
  });
}

async function dispatch(kind: EventKind, entry: AnyLog): Promise<void> {
  try {
    if (kind === "deposit") await handleDeposit(entry);
    else if (kind === "redeem") await handleRedeem(entry);
    else if (kind === "close") await handleClose(entry);
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
  const rows = await db.position.findMany({
    where: { positionTokenAddress: { not: null }, status: { not: "closed" } },
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
  const [deposits, redeems, closes, fundings] = await Promise.all([
    client.getLogs({ address: addresses, event: depositRequestedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: redeemRequestedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: closeRequestedEvent, fromBlock, toBlock }),
    client.getLogs({ address: addresses, event: fundingUpdatedEvent, fromBlock, toBlock }),
  ]);

  // Process in chain order so, e.g., a deposit and a funding update in the
  // same range land in the order they actually happened.
  const ordered = [
    ...deposits.map((entry) => ({ kind: "deposit" as const, entry })),
    ...redeems.map((entry) => ({ kind: "redeem" as const, entry })),
    ...closes.map((entry) => ({ kind: "close" as const, entry })),
    ...fundings.map((entry) => ({ kind: "funding" as const, entry })),
  ].sort((a, b) => compareLogOrder(a.entry, b.entry));

  for (const item of ordered) {
    await dispatch(item.kind, item.entry);
  }

  log.info("backfilled position token events", {
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
    unwatchFns.push(
      client.watchContractEvent({
        address,
        abi: positionTokenAbi,
        eventName: "DepositRequested",
        onLogs: (logs) => logs.forEach((entry) => void dispatch("deposit", entry as unknown as AnyLog)),
      }),
    );
    unwatchFns.push(
      client.watchContractEvent({
        address,
        abi: positionTokenAbi,
        eventName: "RedeemRequested",
        onLogs: (logs) => logs.forEach((entry) => void dispatch("redeem", entry as unknown as AnyLog)),
      }),
    );
    unwatchFns.push(
      client.watchContractEvent({
        address,
        abi: closeRequestAbi,
        eventName: "CloseRequested",
        onLogs: (logs) => logs.forEach((entry) => void dispatch("close", entry as unknown as AnyLog)),
      }),
    );
    unwatchFns.push(
      client.watchContractEvent({
        address,
        abi: positionTokenAbi,
        eventName: "FundingUpdated",
        onLogs: (logs) => logs.forEach((entry) => void dispatch("funding", entry as unknown as AnyLog)),
      }),
    );

    log.debug("watching position token", { address: key });
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
            watchPositionToken(entry.args.positionToken as Address);
          }
        },
      }),
    );

    known.forEach(watchPositionToken);

    log.info("indexer live", { watched: known.size, atBlock: latestBlock.toString() });
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

export { positionTokenAbi, closeRequestAbi };
