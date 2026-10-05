import { db } from "../../config/db";
import { createLogger, errorFields } from "../../lib/logger";
import { credentialsFor, type SlotWithWallet } from "../../services/allocator";
import { PerplTradingConnection } from "./tradingWs";
import type { ApiAccount, ApiPosition } from "./types";

const log = createLogger("perpl:connections");

/**
 * The trading sockets, one per slot (= one per wallet / Perpl account). Opened
 * on demand by the adapter and, at boot, for every slot that has something
 * live on it; position events from all of them reach the handlers registered
 * here (liquidation detection).
 */

export type PositionHandler = (
  slotId: string,
  position: ApiPosition,
  meta: { snapshot: boolean; settlementEvent?: boolean },
) => void;
export type AccountHandler = (slotId: string, account: ApiAccount) => void;

const connections = new Map<string, PerplTradingConnection>();
const positionHandlers: PositionHandler[] = [];
const accountHandlers: AccountHandler[] = [];

export function onPosition(handler: PositionHandler): void {
  positionHandlers.push(handler);
}

export function onAccount(handler: AccountHandler): void {
  accountHandlers.push(handler);
}

/// The slot's connection, created and started if it does not exist yet.
export function ensure(slot: SlotWithWallet): PerplTradingConnection {
  const existing = connections.get(slot.id);
  if (existing) {
    existing.updateCredentials(credentialsFor(slot));
    existing.start();
    return existing;
  }
  const connection = new PerplTradingConnection(slot.id, credentialsFor(slot));
  connection.on("position", (position: ApiPosition, meta: { snapshot: boolean; settlementEvent?: boolean }) => {
    for (const handler of positionHandlers) {
      try {
        handler(slot.id, position, meta);
      } catch (error) {
        log.error("position handler threw", { slotId: slot.id, ...errorFields(error) });
      }
    }
  });
  connection.on("account", (account: ApiAccount) => {
    for (const handler of accountHandlers) {
      try {
        handler(slot.id, account);
      } catch (error) {
        log.error("account handler threw", { slotId: slot.id, ...errorFields(error) });
      }
    }
  });
  connections.set(slot.id, connection);
  connection.start();
  return connection;
}

export function get(slot: Pick<SlotWithWallet, "id">): PerplTradingConnection | undefined {
  return connections.get(slot.id);
}

/// Boot: a socket for every slot in `reserved` / `allocated` / `settling` --
/// the ones with money or a position on them.
export async function openForActiveSlots(): Promise<number> {
  const slots = await db.subaccountSlot.findMany({
    where: { status: { in: ["reserved", "allocated", "settling"] }, perplAccountId: { not: null } },
    include: { operatorWallet: true },
  });
  for (const slot of slots) {
    try {
      ensure(slot);
    } catch (error) {
      log.error("could not open a trading socket for slot", { slotId: slot.id, ...errorFields(error) });
    }
  }
  log.info("trading sockets opened", { count: slots.length });
  return slots.length;
}

export function closeAll(): void {
  for (const connection of connections.values()) connection.stop();
  connections.clear();
}

/// For /health.
export function connectionStates(): Record<string, ReturnType<PerplTradingConnection["status"]>> {
  const states: Record<string, ReturnType<PerplTradingConnection["status"]>> = {};
  for (const [slotId, connection] of connections) states[slotId] = connection.status();
  return states;
}
