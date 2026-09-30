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
 *   npm run smoke -- keys
 *     Key gate. For every slot in the database, sends one signed
 *     cancelAllOrders for (wallet, accountIndex) with that slot's API key and
 *     prints `index n: ✓` or `index n: ✗ <HTTP status + message>`. Laxu only
 *     ever places IOC orders, so nothing rests on a slot and the call changes
 *     nothing -- safe on allocated slots too. A 401/403 means the key is wrong
 *     or bound to a different accountIndex (i.e. the Arcus UI's "Subaccount #"
 *     is not the API index). A random, unregistered key is sent first as a
 *     control: if Arcus accepts it, the route is not checking signatures and
 *     every ✓ below is meaningless.
 *
 * `walletAddress` picks the operator wallet when more than one owns that index.
 */

import { randomBytes } from "node:crypto";

import axios from "axios";
import type { Address } from "viem";

import { cancelAllOrders, getPositions } from "../src/arcus/client";
import { loadEd25519PrivateKey, publicKeyHex } from "../src/arcus/ed25519";
import type { ArcusCredentials } from "../src/arcus/types";
import { ArcusError } from "../src/lib/errors";
import { usdgBalanceOf } from "../src/chain/writes";
import { config } from "../src/config/env";
import { db } from "../src/config/db";
import { fromArcusPositionRow, fromPrice18, fromSize6, fromUsdg6, toUsdg6 } from "../src/lib/units";
import { credentialsFor, type SlotWithWallet } from "../src/services/allocator";
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

/// "HTTP 401 unauthorized: bad signature" -- as much of Arcus's answer as fits a line.
function describeFailure(error: unknown): string {
  if (error instanceof ArcusError) {
    const body = error.body as { message?: string; error?: string | { message?: string } } | string | undefined;
    const detail =
      typeof body === "string"
        ? body
        : body?.message ?? (typeof body?.error === "string" ? body.error : body?.error?.message) ?? JSON.stringify(body ?? "");
    return `HTTP ${error.status ?? "?"} ${detail}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

async function signedProbe(credentials: ArcusCredentials): Promise<string | null> {
  try {
    await cancelAllOrders(credentials);
    return null;
  } catch (error) {
    return describeFailure(error);
  }
}

async function keys(): Promise<void> {
  const slots = await db.subaccountSlot.findMany({
    include: { operatorWallet: true },
    orderBy: [{ operatorWalletId: "asc" }, { accountIndex: "asc" }],
  });
  if (slots.length === 0) throw new Error("No slots in the database -- run `npm run slots:provision` first");

  // Control: a key Arcus has never seen must be refused.
  const seed = randomBytes(32).toString("hex");
  const control = await signedProbe({
    address: slots[0].operatorWallet.address,
    accountIndex: slots[0].accountIndex,
    apiKey: publicKeyHex(loadEd25519PrivateKey(seed)),
    secret: seed,
  });
  if (control === null) {
    console.log("control: ✗ Arcus accepted an unregistered key -- this probe proves nothing; check keys another way");
    process.exitCode = 1;
    return;
  }
  console.log(`control (random key): refused as expected (${control})`);

  let failures = 0;
  for (const slot of slots) {
    const label = `index ${slot.accountIndex}${new Set(slots.map((s) => s.operatorWalletId)).size > 1 ? ` (${slot.operatorWallet.address})` : ""}`;
    let problem: string | null;
    try {
      problem = await signedProbe(credentialsFor(slot));
    } catch (error) {
      problem = describeFailure(error);
    }
    if (problem === null) {
      console.log(`${label}: ✓`);
    } else {
      failures += 1;
      console.log(`${label}: ✗ ${problem}`);
    }
  }

  if (failures > 0) {
    console.log(`
${failures} of ${slots.length} slots failed. Do not open positions on them until fixed.`);
    process.exitCode = 1;
  } else {
    console.log(`
All ${slots.length} slots signed successfully for their accountIndex.`);
  }
}

async function main(): Promise<void> {
  const [command, indexArg, ...rest] = process.argv.slice(2);
  if (command === "keys") {
    await keys();
    return;
  }
  const accountIndex = Number(indexArg);
  if (!command || !Number.isInteger(accountIndex)) {
    throw new Error(
      "Usage: npm run smoke -- keys | units <accountIndex> [wallet] | withdraw <accountIndex> [usd] [wallet]",
    );
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
