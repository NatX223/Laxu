import { parseAbiItem, type Address, type Log } from "viem";

import { db } from "../config/db";
import { config } from "../config/env";
import { publicClient } from "../chain/clients";
import { closeRequestAbi, positionTokenAbi } from "../chain/abi";
import { startWorker } from "../lib/async";
import { createLogger, errorFields } from "../lib/logger";
import { handleDepositRequested, handleRedeemRequested } from "../services/margin";
import { executeClose } from "../services/closePosition";

const log = createLogger("indexer");

/**
 * On-chain event listener.
 *
 * Polls `getLogs` from a durable cursor rather than holding a live subscription.
 * A subscription drops silently on a reconnect and resumes from wherever the
 * node happens to be; a stored cursor means a restart resumes from the exact
 * block it stopped on, which is the whole point of crash recovery here.
 */

const CURSOR = "position-events";

const depositRequestedEvent = parseAbiItem(
  "event DepositRequested(address indexed controller, uint256 assets, uint256 requestId)",
);
const redeemRequestedEvent = parseAbiItem(
  "event RedeemRequested(address indexed controller, uint256 shares, uint256 requestId)",
);
/**
 * NOT YET DEPLOYED. `requestClose()` and `CloseRequested` come from the
 * close-access-control spec and do not exist on the current PositionToken, so
 * this filter matches nothing today. Watching for it costs one extra topic per
 * poll and means the event-driven close path works the day the contract ships;
 * until then `POST /positions/:id/close` drives the same orchestration.
 */
const closeRequestedEvent = parseAbiItem("event CloseRequested(address indexed creator)");

async function readCursor(): Promise<bigint | null> {
  const row = await db.indexerCursor.findUnique({ where: { name: CURSOR } });
  return row ? row.lastProcessedBlock : null;
}

async function writeCursor(block: bigint): Promise<void> {
  await db.indexerCursor.upsert({
    where: { name: CURSOR },
    create: { name: CURSOR, lastProcessedBlock: block },
    update: { lastProcessedBlock: block },
  });
}

/// Addresses to watch: every position whose token exists and is not closed.
async function watchedAddresses(): Promise<Address[]> {
  const rows = await db.position.findMany({
    where: { status: "open", positionTokenAddress: { not: null } },
    select: { positionTokenAddress: true },
  });
  return rows.map((row) => row.positionTokenAddress as Address);
}

export async function pollOnce(): Promise<{ from: bigint; to: bigint; events: number } | null> {
  const client = publicClient();
  const head = await client.getBlockNumber();
  const safeHead = head - BigInt(config.indexerConfirmations);
  if (safeHead <= 0n) return null;

  let cursor = await readCursor();
  if (cursor === null) {
    // First run: start at the head rather than replaying chain history for
    // positions that predate this service.
    cursor = safeHead;
    await writeCursor(cursor);
    log.info("indexer cursor initialised at head", { block: cursor });
    return null;
  }

  if (cursor >= safeHead) return null;

  const from = cursor + 1n;
  const to =
    safeHead - from > BigInt(config.indexerBlockBatchSize)
      ? from + BigInt(config.indexerBlockBatchSize)
      : safeHead;

  const addresses = await watchedAddresses();
  if (addresses.length === 0) {
    await writeCursor(to);
    return { from, to, events: 0 };
  }

  const [deposits, redeems, closes] = await Promise.all([
    client.getLogs({ address: addresses, event: depositRequestedEvent, fromBlock: from, toBlock: to }),
    client.getLogs({ address: addresses, event: redeemRequestedEvent, fromBlock: from, toBlock: to }),
    client.getLogs({ address: addresses, event: closeRequestedEvent, fromBlock: from, toBlock: to }),
  ]);

  // Process in chain order so a deposit and a close in the same range are
  // handled in the order they actually happened.
  const ordered = [
    ...deposits.map((entry) => ({ kind: "deposit" as const, entry })),
    ...redeems.map((entry) => ({ kind: "redeem" as const, entry })),
    ...closes.map((entry) => ({ kind: "close" as const, entry })),
  ].sort(compareLogOrder);

  for (const item of ordered) {
    try {
      if (item.kind === "close") await onCloseRequested(item.entry);
      else await onMarginRequest(item.kind, item.entry);
    } catch (error) {
      log.error("event handler failed", {
        kind: item.kind,
        address: item.entry.address,
        txHash: item.entry.transactionHash,
        ...errorFields(error),
      });
      // Advance past a permanently failing event rather than wedging the cursor:
      // the reconciler owns retry for anything left half-done.
    }
  }

  await writeCursor(to);
  return { from, to, events: ordered.length };
}

type AnyLog = Log<bigint, number, false>;

function compareLogOrder(
  a: { entry: AnyLog },
  b: { entry: AnyLog },
): number {
  const blockDelta = (a.entry.blockNumber ?? 0n) - (b.entry.blockNumber ?? 0n);
  if (blockDelta !== 0n) return blockDelta > 0n ? 1 : -1;
  return (a.entry.logIndex ?? 0) - (b.entry.logIndex ?? 0);
}

async function positionFor(address: string) {
  return db.position.findUnique({
    where: { positionTokenAddress: address.toLowerCase() },
  });
}

async function onMarginRequest(kind: "deposit" | "redeem", entry: AnyLog): Promise<void> {
  const args = (entry as unknown as {
    args: { controller: Address; assets?: bigint; shares?: bigint; requestId: bigint };
  }).args;

  const position = await positionFor(entry.address);
  if (!position) {
    log.warn("event from an unknown position token", { address: entry.address });
    return;
  }

  const event = {
    positionId: position.id,
    positionTokenAddress: position.positionTokenAddress as string,
    amount: (kind === "deposit" ? args.assets : args.shares) ?? 0n,
    controller: args.controller.toLowerCase(),
    requestId: args.requestId.toString(),
  };

  log.info("margin request event", { kind, ...event, amount: event.amount.toString() });

  if (kind === "deposit") await handleDepositRequested(event);
  else await handleRedeemRequested(event);
}

async function onCloseRequested(entry: AnyLog): Promise<void> {
  const position = await positionFor(entry.address);
  if (!position) {
    log.warn("CloseRequested from an unknown position token", { address: entry.address });
    return;
  }
  log.info("CloseRequested", { positionId: position.id, address: entry.address });
  await executeClose(position.id, { wasLiquidated: false });
}

export function startIndexer(): () => void {
  log.info("indexer starting", {
    intervalMs: config.indexerPollIntervalMs,
    batchSize: config.indexerBlockBatchSize,
  });
  return startWorker(
    "indexer",
    config.indexerPollIntervalMs,
    async () => {
      const result = await pollOnce();
      if (result && result.events > 0) {
        log.info("processed block range", result);
      }
    },
    (error) => log.error("indexer poll threw", errorFields(error)),
  );
}

export { positionTokenAbi, closeRequestAbi };
