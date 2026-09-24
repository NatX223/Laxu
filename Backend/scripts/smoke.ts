/**
 * Day-1 smoke tests against Arcus testnet. Both are manual gates: run them
 * before anything that depends on them ships.
 *
 *   npm run smoke -- units <accountIndex> [walletAddress]
 *     Units gate (accounting spec 1.3). Open ONE 0.01 ETH position on that
 *     slot by hand first. Prints the raw GET /v1/positions row and the most
 *     recent raw fills, then what lib/units.ts makes of them. Check that it
 *     reproduces 0.01 ETH, the real fill price and a sensible margin -- and
 *     fix `fromArcusPositionRow` before anything else builds on it.
 *
 *   npm run smoke -- withdraw <accountIndex> [usd=5] [walletAddress]
 *     Withdrawal path (spec 3.3). Withdraws $5 from that slot to its internal
 *     wallet on Robinhood Chain testnet and waits for the WITHDRAWAL event and
 *     the on-chain arrival. Confirm it on the explorer too.
 *
 * `walletAddress` picks the operator wallet when more than one owns that index.
 */

import axios from "axios";
import type { Address } from "viem";

import { getPositions } from "../src/arcus/client";
import { usdgBalanceOf } from "../src/chain/writes";
import { config } from "../src/config/env";
import { db } from "../src/config/db";
import { fromArcusPositionRow, fromPrice18, fromSize6, fromUsdg6, toUsdg6 } from "../src/lib/units";
import type { SlotWithWallet } from "../src/services/allocator";
import { closeArcusStream } from "../src/services/arcusStream";
import { awaitUsdgArrival, awaitWithdrawalApplied, withdrawable6, withdrawToInternalWallet } from "../src/services/arcusWithdraw";
import { markPriceFor, requireMarket } from "../src/services/markets";

async function slotFor(accountIndex: number, wallet?: string): Promise<SlotWithWallet> {
  const slots = await db.subaccountSlot.findMany({
    where: {
      accountIndex,
      ...(wallet ? { operatorWallet: { address: { equals: wallet, mode: "insensitive" } } } : {}),
    },
    include: { operatorWallet: true },
  });
  if (slots.length !== 1) {
    throw new Error(`${slots.length} slots match index ${accountIndex}${wallet ? ` on ${wallet}` : ""}; pass the wallet address`);
  }
  return slots[0];
}

async function units(slot: SlotWithWallet): Promise<void> {
  const address = slot.operatorWallet.address;
  const rows = await getPositions(address, slot.accountIndex);
  console.log("RAW GET /v1/positions:", JSON.stringify(rows, null, 2));

  const fills = await axios.get(`${config.arcusApiBaseUrl}/v1/fills`, {
    params: { address, accountIndex: slot.accountIndex, limit: 5 },
    validateStatus: () => true,
  });
  console.log("RAW GET /v1/fills (latest 5):", JSON.stringify(fills.data, null, 2));

  for (const row of rows) {
    const market = await db.market.findFirst({ where: { arcusMarketId: row.marketId } });
    const mark = market ? await markPriceFor(await requireMarket(market.id)) : undefined;
    const parsed = fromArcusPositionRow(row, mark);
    console.log(`PARSED ${row.marketDisplayName}:`, {
      size: `${fromSize6(parsed.size6)} (size6 ${parsed.size6})`,
      entry: `${fromPrice18(parsed.entry18)} (entry18 ${parsed.entry18})`,
      mark: parsed.mark18 !== null ? fromPrice18(parsed.mark18) : "n/a",
      fundingSinceOpen: `${fromUsdg6(parsed.funding6)} USDG`,
      marginUsed: row.marginUsed ?? "n/a",
    });
  }
  console.log(`withdrawable now: ${fromUsdg6(await withdrawable6(slot))} USDG`);
}

async function withdraw(slot: SlotWithWallet, usd: string): Promise<void> {
  const wallet = slot.operatorWallet.address as Address;
  const before = await usdgBalanceOf(wallet);
  console.log(`internal wallet ${wallet} holds ${fromUsdg6(before)} USDG; withdrawing ${usd} (${config.arcusWithdrawSigning} signing)`);

  const handle = await withdrawToInternalWallet(slot, toUsdg6(usd));
  console.log("submitted:", { withdrawalId: handle.withdrawalId, amount: fromUsdg6(handle.amount6) });

  const applied = await awaitWithdrawalApplied(slot, handle.withdrawalId, { since: handle.submittedAt, amount6: handle.amount6 });
  console.log(`applied on Arcus: ${fromUsdg6(applied)} USDG`);

  await awaitUsdgArrival(wallet, before + applied);
  console.log(`arrived on-chain: wallet now holds ${fromUsdg6(await usdgBalanceOf(wallet))} USDG`);
}

async function main(): Promise<void> {
  const [command, indexArg, ...rest] = process.argv.slice(2);
  const accountIndex = Number(indexArg);
  if (!command || !Number.isInteger(accountIndex)) {
    throw new Error("Usage: npm run smoke -- units <accountIndex> [wallet] | withdraw <accountIndex> [usd] [wallet]");
  }
  if (command === "units") {
    await units(await slotFor(accountIndex, rest[0]));
  } else if (command === "withdraw") {
    const usd = rest[0] && !rest[0].startsWith("0x") ? rest[0] : "5";
    const wallet = rest.find((arg) => arg.startsWith("0x"));
    await withdraw(await slotFor(accountIndex, wallet), usd);
  } else {
    throw new Error(`Unknown command ${command}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    closeArcusStream();
    await db.$disconnect();
  });
