import type { Address } from "viem";

import { WAD } from "../chain/abi";
import {
  ensureLiquidatorApproval,
  healthFactorFor,
  liquidate,
  maxLiquidatableDebtFor,
  requestRedeemAsLiquidator,
} from "../chain/writes";
import { db } from "../config/db";
import { config } from "../config/env";
import { startWorker } from "../lib/async";
import { createLogger, errorFields } from "../lib/logger";

const log = createLogger("liquidator");

/**
 * Lending-side liquidation bot.
 *
 * Entirely separate surface from the Arcus-side detection in reporter.ts --
 * this one is Laxu's own liquidation, already fully built into LendingPool:
 * `liquidate()` is permissionless, close-factor/dust logic lives in
 * `maxLiquidatableDebt()`, and the seizure bonus is baked into the shares it
 * hands back. Nothing here decides risk parameters; it only watches
 * `healthFactor()` and calls what's already there.
 *
 * `liquidate()` deliberately has no `freshOracle` guard (see the contract's
 * own rationale) -- never skip a check because the underlying price report is
 * stale, that is exactly the state liquidation exists to protect against.
 */
export async function runLiquidationTick(): Promise<void> {
  const pools = await db.lendingPool.findMany({ include: { borrowers: true } });

  for (const pool of pools) {
    const poolAddress = pool.poolAddress as Address;

    for (const borrower of pool.borrowers) {
      const borrowerAddress = borrower.address as Address;

      try {
        const hf = await healthFactorFor(poolAddress, borrowerAddress);
        if (hf >= WAD) continue;

        const repayAmount = await maxLiquidatableDebtFor(poolAddress, borrowerAddress);
        if (repayAmount === 0n) continue;

        await ensureLiquidatorApproval(poolAddress, repayAmount);
        const { txHash, seizedShares } = await liquidate(poolAddress, borrowerAddress, repayAmount);

        log.info("liquidated borrower", {
          pool: poolAddress,
          borrower: borrowerAddress,
          repayAmount: repayAmount.toString(),
          seizedShares: seizedShares.toString(),
          txHash,
        });

        // Recycling is the liquidator's own problem to solve, on its own
        // clock -- this just queues the redeem through the existing
        // fractional-redeem flow rather than leaving the capital as shares.
        if (seizedShares > 0n) {
          await requestRedeemAsLiquidator(pool.positionTokenAddress as Address, seizedShares);
        }
      } catch (error) {
        log.error("could not liquidate borrower", {
          pool: poolAddress,
          borrower: borrowerAddress,
          ...errorFields(error),
        });
      }
    }
  }
}

export function startLiquidationJob(): () => void {
  log.info("liquidator starting", { intervalMs: config.liquidatorIntervalMs });
  return startWorker(
    "liquidator",
    config.liquidatorIntervalMs,
    runLiquidationTick,
    (error) => log.error("liquidation tick threw", errorFields(error)),
  );
}
