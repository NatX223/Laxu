import type { Address } from "viem";

import { floatAddress } from "../chain/clients";
import { assetBalanceOf, transferAsset } from "../chain/writes";
import { createLogger } from "../lib/logger";
import { fromAsset6 } from "../lib/units";
import { venue } from "../venue/types";
import { slotWallet, type SlotWithWallet } from "./allocator";
import { withSlotLock } from "./float";

const log = createLogger("sweep");

/// Below this a withdrawal is not worth a transaction (and may be under the
/// exchange's minimum); it stays in the account as part of the reserve.
const DUST = 10_000n; // 0.01 at 6dp

/**
 * Empty a slot before it is recycled: everything in its Perpl account above
 * the reserve is withdrawn to the slot wallet, and the slot wallet's whole
 * asset balance goes to the float. Without this, the next user handed the slot
 * would inherit someone else's money in every balance check.
 *
 * The reserve (Perpl's minimum account open amount) stays in the account
 * forever -- it is never user money.
 */
export async function sweepSlot(slot: SlotWithWallet): Promise<{ withdrawn: bigint; moved: bigint }> {
  return withSlotLock(slot.id, async () => {
    const reserve = BigInt(slot.reserve);
    const free = await venue().accountBalance(slot);
    const excess = free > reserve ? free - reserve : 0n;
    let withdrawn = 0n;
    if (excess >= DUST) {
      await venue().withdraw(slot, excess);
      withdrawn = excess;
    }

    const wallet = slot.operatorWallet.address as Address;
    const held = await assetBalanceOf(wallet);
    if (held > 0n) await transferAsset(slotWallet(slot), floatAddress(), held);

    if (withdrawn > 0n || held > 0n) {
      log.info("slot swept", { slotId: slot.id, withdrawn: fromAsset6(withdrawn), toFloat: fromAsset6(held) });
    }
    return { withdrawn, moved: held };
  });
}
