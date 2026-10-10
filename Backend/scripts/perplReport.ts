/**
 * `npm run perpl:report` -- read-only numbers for docs/PERPL.md.
 *
 *   1. Per-position PnL: every Laxu position, from its fills and realised
 *      funding on Perpl (the same matching as the "Fills on Perpl" panel,
 *      services/venueFills.ts). Gross = sell notional - buy notional.
 *   2. Activity: orders and fills on every slot's Perpl account (signed
 *      history endpoints), tokens and pools from the factories' own counters,
 *      lending events from each pool's logs, and the database's rows.
 *
 * Sends nothing: no transaction, no order. Prints Markdown tables to stdout.
 */

import { parseAbiItem, type Address } from "viem";

import { publicClient } from "../src/chain/clients";
import { connectDb, db } from "../src/config/db";
import { credentialsFor, getSlot } from "../src/services/allocator";
import { venueFillsFor } from "../src/services/venueFills";
import { getFills, getOrderHistory, walkHistory } from "../src/venue/perpl/rest";
import { closeAll } from "../src/venue/perpl/connections";

const DEPLOY = require("../../Contracts/deployments/monadTestnet.json");
const POSITION_FACTORY = DEPLOY.contracts.PositionTokenFactory.address as Address;
const POOL_FACTORY = DEPLOY.contracts.LendingPoolFactory.address as Address;
const LOGS_RANGE = 100n;

const countAbi = (name: string) => [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;

const lendingEvents = [
  parseAbiItem("event CollateralDeposited(address indexed user, uint256 shares)"),
  parseAbiItem("event CollateralWithdrawn(address indexed user, uint256 shares)"),
  parseAbiItem("event Borrowed(address indexed user, uint256 amount)"),
  parseAbiItem("event Repaid(address indexed user, uint256 principal, uint256 interest)"),
  parseAbiItem("event Liquidated(address indexed liquidator, address indexed borrower, uint256 repayAmount, uint256 seizedShares)"),
];

const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString().replace(".000Z", "Z") : "-");
const f = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "-");

async function blockAt(timestampSec: number, head: bigint): Promise<bigint> {
  let lo = BigInt(DEPLOY.contracts.LendingPoolFactory.block);
  let hi = head;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const block = await publicClient().getBlock({ blockNumber: mid });
    if (Number(block.timestamp) < timestampSec) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

async function pnlTable(): Promise<void> {
  const positions = await db.position.findMany({
    where: { positionTokenAddress: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\n## Per-position PnL from Perpl fills (${positions.length} Laxu positions in the database)\n`);
  console.log("| Token | Market | Side | Lev | Status | Opened | Closed | Fills | Avg entry | Avg exit | Gross PnL | Fees | Funding | Net |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const p of positions) {
    const token = p.positionTokenAddress as string;
    const r = await venueFillsFor(token);
    let buyQty = 0, buyNotional = 0, sellQty = 0, sellNotional = 0, fees = 0;
    let openQty = 0, openNotional = 0, closeQty = 0, closeNotional = 0;
    for (const fill of r.fills) {
      const qty = Number(fill.sizeHuman);
      const px = Number(fill.priceHuman ?? "NaN");
      fees += Number(fill.feeHuman);
      if (fill.side === "buy") { buyQty += qty; buyNotional += qty * px; } else { sellQty += qty; sellNotional += qty * px; }
      if (fill.action === "open") { openQty += qty; openNotional += qty * px; } else { closeQty += qty; closeNotional += qty * px; }
    }
    const flat = Math.abs(buyQty - sellQty) < 1e-12;
    const gross = flat ? sellNotional - buyNotional : NaN;
    const funding = r.realisedFunding === null ? NaN : Number(r.realisedFunding);
    const net = gross - fees + funding;
    const market = r.market ?? "?";
    console.log(
      `| \`${token.slice(0, 10)}…\` | ${market} | ${p.direction} | ${p.leverage}x | ${p.status} | ${f(openQty, 5)} | ${f(closeQty, 5)} | ${r.fills.length} (${r.matchedBy ?? "-"}) | ${f(openNotional / openQty, 2)} | ${closeQty > 0 ? f(closeNotional / closeQty, 2) : "-"} | ${flat ? f(gross, 6) : "open"} | ${f(fees, 6)} | ${f(funding, 6)} | ${flat ? f(net, 6) : "-"} |`,
    );
  }
}

async function venueActivity(): Promise<void> {
  const slots = await db.subaccountSlot.findMany({ orderBy: { id: "asc" } });
  console.log(`\n## Perpl accounts (${slots.length} slots in the database)\n`);
  console.log("| Slot | Wallet | Perpl account | Status | Orders (order-history) | Filled orders | Fills | First fill | Last fill |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  let totalOrders = 0, totalFilled = 0, totalFills = 0;
  for (const row of slots) {
    const slot = await getSlot(row.id);
    if (!slot.perplAccountId) {
      console.log(`| \`${row.id.slice(-6)}\` | ${slot.operatorWallet.address} | - | ${row.status} | - | - | - | - | - |`);
      continue;
    }
    const creds = credentialsFor(slot);
    const orders = await walkHistory((page) => getOrderHistory(creds, page, 100), () => false, 100);
    const fills = await walkHistory((page) => getFills(creds, page, 100), () => false, 100);
    // order-history has one row per order update; count distinct order ids.
    const byOid = new Map<string, number>();
    for (const o of orders as Array<{ oid?: number; fs?: number }>) {
      const oid = String(o.oid);
      byOid.set(oid, Math.max(byOid.get(oid) ?? 0, Number(o.fs ?? 0)));
    }
    const filled = [...byOid.values()].filter((fs) => fs > 0).length;
    const times = fills.map((x) => x.at?.t).filter((t): t is number => typeof t === "number").sort((a, b) => a - b);
    totalOrders += byOid.size;
    totalFilled += filled;
    totalFills += fills.length;
    console.log(
      `| \`${row.id.slice(-6)}\` | ${slot.operatorWallet.address} | ${slot.perplAccountId} | ${row.status} | ${byOid.size} | ${filled} | ${fills.length} | ${iso(times[0])} | ${iso(times[times.length - 1])} |`,
    );
  }
  console.log(`| **All** | | | | **${totalOrders}** | **${totalFilled}** | **${totalFills}** | | |`);
}

async function chainActivity(withLogs: boolean): Promise<void> {
  const client = publicClient();
  const head = await client.getBlockNumber();
  const [tokens, pools] = await Promise.all([
    client.readContract({ address: POSITION_FACTORY, abi: countAbi("allPositionsCount"), functionName: "allPositionsCount" }),
    client.readContract({ address: POOL_FACTORY, abi: countAbi("allPoolsCount"), functionName: "allPoolsCount" }),
  ]);
  console.log(`\n## On-chain (head ${head})\n`);
  console.log(`- PositionTokenFactory.allPositionsCount() = ${tokens}`);
  console.log(`- LendingPoolFactory.allPoolsCount() = ${pools}`);

  if (!withLogs) return;
  // Lending events, per pool, from its creation to its position's close (+ 2,000 blocks) or now.
  const rows = await db.lendingPool.findMany({ orderBy: { createdAt: "asc" } });
  const counts: Record<string, number> = {};
  const users = new Set<string>();
  console.log("\n| Pool | Token | Blocks scanned | Deposits | Withdrawals | Borrows | Repays | Liquidations |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const pool of rows) {
    const position = await db.position.findFirst({ where: { positionTokenAddress: pool.positionTokenAddress } });
    const from = await blockAt(Math.floor(pool.createdAt.getTime() / 1000) - 120, head);
    const to = position?.closedAt ? (await blockAt(Math.floor(position.closedAt.getTime() / 1000), head)) + 2_000n : head;
    const per: Record<string, number> = {};
    for (let start = from; start <= to; start += LOGS_RANGE) {
      const end = start + LOGS_RANGE - 1n > to ? to : start + LOGS_RANGE - 1n;
      const logs = await client.getLogs({ address: pool.poolAddress as Address, events: lendingEvents, fromBlock: start, toBlock: end });
      for (const log of logs) {
        per[log.eventName] = (per[log.eventName] ?? 0) + 1;
        counts[log.eventName] = (counts[log.eventName] ?? 0) + 1;
        const who = (log.args as { user?: string; borrower?: string }).user ?? (log.args as { borrower?: string }).borrower;
        if (who) users.add(who.toLowerCase());
      }
    }
    console.log(
      `| \`${pool.poolAddress.slice(0, 10)}…\` | \`${pool.positionTokenAddress.slice(0, 10)}…\` | ${from}–${to} | ${per.CollateralDeposited ?? 0} | ${per.CollateralWithdrawn ?? 0} | ${per.Borrowed ?? 0} | ${per.Repaid ?? 0} | ${per.Liquidated ?? 0} |`,
    );
  }
  console.log(`\nLending totals: ${JSON.stringify(counts)}; distinct borrower wallets: ${users.size}`);
}

async function dbActivity(): Promise<void> {
  const [requests, positions, flows, users, holders, funding] = await Promise.all([
    db.positionOpenRequest.groupBy({ by: ["status"], _count: true }),
    db.position.groupBy({ by: ["status"], _count: true }),
    db.flow.groupBy({ by: ["type"], _count: true }),
    db.user.count(),
    db.holding.findMany({ select: { address: true } }),
    db.positionReport.count(),
  ]);
  const first = await db.positionOpenRequest.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  const last = await db.positionOpenRequest.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const creators = await db.position.findMany({ distinct: ["userWalletAddress"], select: { userWalletAddress: true } });
  const flowWallets = await db.flow.findMany({ distinct: ["address"], select: { address: true } });
  console.log("\n## Database\n");
  console.log(`- open requests by status: ${requests.map((r) => `${r.status} ${r._count}`).join(", ")}`);
  console.log(`- positions by status: ${positions.map((r) => `${r.status} ${r._count}`).join(", ")}`);
  console.log(`- flows by type: ${flows.map((r) => `${r.type} ${r._count}`).join(", ")}`);
  console.log(`- NAV report rows (position_reports): ${funding}`);
  console.log(`- users: ${users}; distinct creators: ${creators.length}; distinct flow wallets: ${flowWallets.length}; distinct holder rows' wallets: ${new Set(holders.map((h) => h.address.toLowerCase())).size}`);
  console.log(`- open requests from ${first?.createdAt.toISOString() ?? "-"} to ${last?.createdAt.toISOString() ?? "-"}`);
}

async function main(): Promise<void> {
  await connectDb();
  await pnlTable();
  await venueActivity();
  await dbActivity();
  await chainActivity(process.argv.includes("--with-logs"));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    closeAll();
    await db.$disconnect();
  });
