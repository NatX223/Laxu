import type { Address } from "viem";

import { WAD } from "../chain/abi";
import { liquidatorWallet } from "../chain/clients";
import {
  claimAsLiquidator,
  ensureLiquidatorApproval,
  healthFactorFor,
  isClosed,
  liquidate,
  maxLiquidatableDebtFor,
  readSettlement,
  requestRedeemAsLiquidator,
  shareBalanceOf,
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

  // Seized shares of a position that closed before they could be redeemed are
  // held until it settles, then claimed -- retried here every tick.
  await claimSettledHoldings([...new Set(pools.map((p) => p.positionTokenAddress.toLowerCase()))] as Address[]);

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
        // clock -- rather than leaving the capital as shares.
        if (seizedShares > 0n) await recycleSeizedShares(pool.positionTokenAddress as Address, seizedShares);
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

/**
 * By the position's state:
 *   open                 -> requestRedeem through the fractional-redeem flow
 *   closed, not settled  -> hold; {claimSettledHoldings} retries every tick
 *   settled              -> claim()
 */
async function recycleSeizedShares(positionToken: Address, shares: bigint): Promise<void> {
  if ((await readSettlement(positionToken)).settled) {
    const txHash = await claimAsLiquidator(positionToken);
    log.info("claimed seized shares of a settled position", { positionToken, txHash });
  } else if (await isClosed(positionToken)) {
    log.info("position closed but not settled; holding seized shares until it is", { positionToken });
  } else {
    await requestRedeemAsLiquidator(positionToken, shares);
  }
}

async function claimSettledHoldings(tokens: Address[]): Promise<void> {
  const liquidator = liquidatorWallet().account?.address;
  if (!liquidator) return;
  for (const token of tokens) {
    try {
      if ((await shareBalanceOf(token, liquidator)) === 0n) continue;
      if (!(await readSettlement(token)).settled) continue;
      const txHash = await claimAsLiquidator(token);
      log.info("claimed held seized shares after settlement", { positionToken: token, txHash });
    } catch (error) {
      log.error("could not claim held seized shares", { positionToken: token, ...errorFields(error) });
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
