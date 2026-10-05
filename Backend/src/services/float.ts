import type { Address } from "viem";

import { floatAddress, floatWallet } from "../chain/clients";
import { assetBalanceOf, mintAsset, transferAsset } from "../chain/writes";
import { config } from "../config/env";
import { alert, createLogger } from "../lib/logger";
import { fromAsset6 } from "../lib/units";
import type { SlotWithWallet } from "./allocator";

const log = createLogger("float");

/**
 * The float: asset held by FLOAT_PRIVATE_KEY that fronts buy-in funding and
 * redeem / trigger payouts. A buyer's asset stays inside the PositionToken as
 * the payout buffer, so the venue side of a buy-in is paid from here; the
 * freed margin of a redeem is withdrawn back to it afterwards.
 */

/// The float cannot cover a movement. Routes map it to 503; flows retry later.
export class FloatShortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FloatShortError";
  }
}

export function floatBalance(): Promise<bigint> {
  return assetBalanceOf(floatAddress());
}

/**
 * Make sure the slot wallet holds at least `amount` of the asset: mint the
 * shortfall when the test token allows it (ASSET_MINTABLE), otherwise move it
 * from the float wallet. A float that is itself short alerts and throws.
 */
export async function ensureSlotFloat(slot: SlotWithWallet, amount: bigint): Promise<void> {
  const walletAddress = slot.operatorWallet.address as Address;
  const balance = await assetBalanceOf(walletAddress);
  if (balance >= amount) return;
  const shortfall = amount - balance;

  if (config.assetMintable) {
    await mintAsset(floatWallet(), walletAddress, shortfall);
    log.info("slot wallet topped up by mint", { slotId: slot.id, amount: fromAsset6(shortfall) });
    return;
  }

  const available = await floatBalance();
  if (available < shortfall) {
    alert("float is short; refill FLOAT_PRIVATE_KEY's wallet", {
      float: floatAddress(),
      holds: fromAsset6(available),
      needs: fromAsset6(shortfall),
    });
    throw new FloatShortError(`Float holds ${fromAsset6(available)}, needs ${fromAsset6(shortfall)}`);
  }
  await transferAsset(floatWallet(), walletAddress, shortfall);
  log.info("slot wallet topped up from the float", { slotId: slot.id, amount: fromAsset6(shortfall) });
}

/**
 * One venue money movement per slot at a time in this process: a buy-in's
 * deposit -> order -> margin top-up must not interleave with a recycle or a
 * sweep withdrawing the same free balance.
 */
const slotQueues = new Map<string, Promise<unknown>>();

export function withSlotLock<T>(slotId: string, task: () => Promise<T>): Promise<T> {
  const previous = slotQueues.get(slotId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  slotQueues.set(slotId, tail);
  void tail.then(() => {
    if (slotQueues.get(slotId) === tail) slotQueues.delete(slotId);
  });
  return run;
}
