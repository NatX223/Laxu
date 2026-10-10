/**
 * `npm run slots:register` -- put slots whose Perpl account and API key already
 * exist (made by hand, or by an earlier `slots:provision` run) into the
 * database. Dry run by default; `--apply` writes. Idempotent: a second run
 * finds every row in place and changes nothing.
 *
 * Unlike `slots:provision` this never creates an account, approves, or turns
 * forwarding on. It only checks, read-only, that each slot is ready:
 *
 *   - SECRET_SLOT_<n>_EVM controls the wallet; SECRET_SLOT_<n>_API loads as an Ed25519 key;
 *   - the wallet has a Perpl account holding at least the reserve;
 *   - one signed `GET /v1/trading/wallet` with PERPL_API_KEY_<n> answers for this
 *     wallet and account, with forwarding on;
 *   - a new slot has no open position on Perpl.
 *
 * An existing row keeps its status and position: only the key token, the secret
 * refs, the account id, forwarding and the reserve are brought up to date.
 *
 * Money above the reserve in a new slot's account would be paid to the first
 * position's holders at settlement (settlement.ts recovers everything above the
 * reserve), so such a slot is not registered unless `--sweep-excess` is given.
 * With it, `--apply` creates the row as `settling` (never handed out), runs the
 * same sweep settlement uses (excess -> slot wallet -> float wallet), and only
 * then marks the slot `free`.
 *
 *   npm run slots:register                          # dry run, slots 1..SLOT_COUNT with a key set
 *   npm run slots:register -- --slots 3,4,5
 *   npm run slots:register -- --slots 3,4,5 --sweep-excess --apply
 *
 * Prints no key or secret: only the API key token's last 4 characters.
 */

import type { Address } from "viem";

import { addressOfKey, floatAddress, publicClient } from "../src/chain/clients";
import { assetBalanceOf } from "../src/chain/writes";
import { db } from "../src/config/db";
import { config } from "../src/config/env";
import { loadEd25519PrivateKey } from "../src/lib/ed25519";
import { getSlot } from "../src/services/allocator";
import { sweepSlot } from "../src/services/sweep";
import { getAccountByAddr, getMinAccountOpenCNS, getWithdrawAllowanceData } from "../src/venue/perpl/exchange";
import { getPositions, getWallet } from "../src/venue/perpl/rest";
import { cnsToAsset, collateralScale } from "../src/venue/perpl/units";

/// Same threshold sweep.ts uses: below it, money above the reserve is left in place.
const DUST = 10_000n;

const apply = process.argv.includes("--apply");
const sweepExcess = process.argv.includes("--sweep-excess");

function slotList(): number[] {
  const i = process.argv.indexOf("--slots");
  if (i >= 0) {
    const raw = process.argv[i + 1] ?? "";
    if (!/^\d+(,\d+)*$/.test(raw)) throw new Error("--slots takes a comma-separated list, e.g. 3,4,5");
    return raw.split(",").map(Number);
  }
  const count = Number(process.env.SLOT_COUNT || 5);
  return Array.from({ length: count }, (_, k) => k + 1).filter((n) => process.env[`SECRET_SLOT_${n}_EVM`]);
}

const ausd = (units: bigint) => (Number(units) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });

interface Plan {
  n: number;
  address: string;
  account: string;
  keyTail: string;
  balance: bigint;
  excess: bigint;
  action: "create" | "update" | "unchanged" | "blocked";
  changes: string[];
  problems: string[];
  rowStatus?: string;
}

async function check(n: number, reserve: bigint): Promise<Plan> {
  const evmRef = `SLOT_${n}_EVM`;
  const apiRef = `SLOT_${n}_API`;
  const plan: Plan = { n, address: "-", account: "-", keyTail: "-", balance: 0n, excess: 0n, action: "blocked", changes: [], problems: [] };

  const evmKey = process.env[`SECRET_${evmRef}`];
  const apiKey = process.env[`PERPL_API_KEY_${n}`];
  const apiSecret = process.env[`SECRET_${apiRef}`];
  if (!evmKey) plan.problems.push(`SECRET_${evmRef} not set`);
  if (!apiKey) plan.problems.push(`PERPL_API_KEY_${n} not set`);
  if (!apiSecret) plan.problems.push(`SECRET_${apiRef} not set`);
  if (!evmKey || !apiKey || !apiSecret) return plan;
  plan.keyTail = `…${apiKey.slice(-4)}`;

  try {
    loadEd25519PrivateKey(apiSecret);
  } catch {
    plan.problems.push(`SECRET_${apiRef} does not load as an Ed25519 key`);
  }

  const address = addressOfKey(evmKey, `SECRET_${evmRef}`).toLowerCase();
  plan.address = address;

  const info = await getAccountByAddr(address as Address);
  if (info.accountId === 0n) {
    plan.problems.push("no Perpl account (run slots:provision)");
    return plan;
  }
  plan.account = info.accountId.toString();
  if (info.frozen !== 0) plan.problems.push(`Perpl account is frozen (${info.frozen})`);
  const scale = await collateralScale();
  const free = info.balanceCNS > info.lockedBalanceCNS ? info.balanceCNS - info.lockedBalanceCNS : 0n;
  plan.balance = cnsToAsset(free, scale);
  if (plan.balance < reserve) plan.problems.push(`account holds ${ausd(plan.balance)} AUSD, below the ${ausd(reserve)} AUSD reserve`);
  plan.excess = plan.balance > reserve ? plan.balance - reserve : 0n;

  let forwarding = false;
  let openPositions = 0;
  try {
    const credentials = { address, perplAccountId: plan.account, apiKey, apiSecret };
    const wallet = await getWallet(credentials);
    if (wallet.addr.toLowerCase() !== address) plan.problems.push(`API key ${plan.keyTail} belongs to ${wallet.addr}`);
    const account = (wallet.as ?? []).find((a) => String(a.id) === plan.account);
    if (!account) plan.problems.push(`signed read does not list account ${plan.account}`);
    forwarding = account?.fw === true;
    if (!forwarding) plan.problems.push("order forwarding is off (run slots:provision)");
    openPositions = (await getPositions(credentials)).d.length;
  } catch (error) {
    plan.problems.push(`signed read failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }

  const existingWallet = await db.operatorWallet.findUnique({ where: { address } });
  const existing = existingWallet
    ? await db.subaccountSlot.findUnique({
        where: { operatorWalletId_accountIndex: { operatorWalletId: existingWallet.id, accountIndex: 0 } },
      })
    : null;

  if (!existing) {
    if (openPositions > 0) plan.problems.push(`${openPositions} open position(s) on Perpl; a new slot must start flat`);
    if (plan.excess >= DUST && !sweepExcess) {
      plan.problems.push(
        `${ausd(plan.excess)} AUSD above the reserve would go to the first position's holders at settlement; ` +
          "withdraw it first or pass --sweep-excess",
      );
    }
    if (plan.problems.length > 0) return plan;
    plan.action = "create";
    plan.changes.push(`new row: wallet ${address}, account ${plan.account}, reserve ${ausd(reserve)} AUSD, status free`);
    if (plan.excess >= DUST) {
      plan.changes.push(`sweep ${ausd(plan.excess)} AUSD: Perpl account -> slot wallet -> float ${floatAddress()}`);
    }
    return plan;
  }

  plan.rowStatus = existing.status;
  if (plan.problems.length > 0) return plan;
  const wanted = {
    evmSignerRef: evmRef,
    apiKey,
    apiSecretRef: apiRef,
    perplAccountId: plan.account,
    forwardingEnabled: forwarding,
    reserve: reserve.toString(),
  };
  if (existingWallet!.evmSignerRef !== wanted.evmSignerRef) plan.changes.push(`evmSignerRef -> ${wanted.evmSignerRef}`);
  if (existing.apiKey !== wanted.apiKey) plan.changes.push(`apiKey …${existing.apiKey.slice(-4)} -> ${plan.keyTail}`);
  if (existing.apiSecretRef !== wanted.apiSecretRef) plan.changes.push(`apiSecretRef -> ${wanted.apiSecretRef}`);
  if (existing.perplAccountId !== wanted.perplAccountId) plan.changes.push(`perplAccountId ${existing.perplAccountId} -> ${wanted.perplAccountId}`);
  if (existing.forwardingEnabled !== wanted.forwardingEnabled) plan.changes.push(`forwardingEnabled -> ${wanted.forwardingEnabled}`);
  if (existing.reserve !== wanted.reserve) plan.changes.push(`reserve ${existing.reserve} -> ${wanted.reserve}`);
  // A row left `settling` by an interrupted --sweep-excess run, with no position on it.
  if (existing.status === "settling" && !existing.positionId && sweepExcess) {
    plan.changes.push(plan.excess >= DUST ? `finish sweep of ${ausd(plan.excess)} AUSD, then status free` : "status settling -> free");
  }
  plan.action = plan.changes.length > 0 ? "update" : "unchanged";
  return plan;
}

async function applyPlan(plan: Plan, reserve: bigint): Promise<void> {
  const evmRef = `SLOT_${plan.n}_EVM`;
  const fields = {
    apiKey: process.env[`PERPL_API_KEY_${plan.n}`]!,
    apiSecretRef: `SLOT_${plan.n}_API`,
    perplAccountId: plan.account,
    forwardingEnabled: true,
    reserve: reserve.toString(),
  };
  const needsSweep = plan.excess >= DUST;

  const slotId = await db.$transaction(async (tx) => {
    const wallet = await tx.operatorWallet.upsert({
      where: { address: plan.address },
      create: { address: plan.address, evmSignerRef: evmRef },
      update: { evmSignerRef: evmRef },
    });
    const row = await tx.subaccountSlot.upsert({
      where: { operatorWalletId_accountIndex: { operatorWalletId: wallet.id, accountIndex: 0 } },
      // Out of the pool until the sweep below has run.
      create: { operatorWalletId: wallet.id, accountIndex: 0, ...fields, status: needsSweep ? "settling" : "free" },
      update: fields,
    });
    return row.id;
  });

  const slot = await getSlot(slotId);
  if (slot.status !== "settling" || slot.positionId || !sweepExcess) return;
  if (needsSweep) {
    const { withdrawn, moved } = await sweepSlot(slot);
    console.log(`  slot ${plan.n}: swept, withdrew ${ausd(withdrawn)} AUSD, moved ${ausd(moved)} AUSD to the float`);
  }
  await db.subaccountSlot.update({ where: { id: slotId }, data: { status: "free" } });
}

async function main(): Promise<void> {
  const slots = slotList();
  if (slots.length === 0) throw new Error("no slots: set SECRET_SLOT_<n>_EVM or pass --slots");

  const scale = await collateralScale();
  const minAsset = cnsToAsset(await getMinAccountOpenCNS(), scale);
  const reserve = config.perplSlotReserve ? BigInt(config.perplSlotReserve) : minAsset;
  console.log(`${apply ? "APPLY" : "DRY RUN"}: slots ${slots.join(", ")}; reserve ${ausd(reserve)} AUSD (Perpl minimum account open ${ausd(minAsset)})`);

  const plans: Plan[] = [];
  for (const n of slots) {
    try {
      plans.push(await check(n, reserve));
    } catch (error) {
      const problem = error instanceof Error ? error.message.split("\n")[0] : String(error);
      plans.push({ n, address: "-", account: "-", keyTail: "-", balance: 0n, excess: 0n, action: "blocked", changes: [], problems: [problem] });
    }
  }

  const totalSweep = plans.filter((p) => p.changes.some((c) => c.includes("sweep"))).reduce((s, p) => s + p.excess, 0n);
  if (totalSweep > 0n) {
    const block = await publicClient().getBlockNumber();
    const allowance = await getWithdrawAllowanceData(block);
    console.log(
      `Exchange-wide withdrawal allowance now: ${ausd(cnsToAsset(allowance.allowanceCNS, scale))} AUSD ` +
        `(${ausd(cnsToAsset(allowance.cnsPerBlock, scale))} AUSD/block); sweeps total ${ausd(totalSweep)} AUSD. ` +
        `Float ${floatAddress()} holds ${ausd(await assetBalanceOf(floatAddress()))} AUSD.`,
    );
  }

  console.log("");
  console.log("n  wallet                                      account  key    balance (AUSD)  row        action");
  for (const p of plans) {
    console.log(
      `${String(p.n).padEnd(2)} ${p.address.padEnd(42)}  ${p.account.padEnd(7)}  ${p.keyTail.padEnd(5)}  ${ausd(p.balance).padStart(14)}  ${(p.rowStatus ?? "none").padEnd(9)}  ${p.action}`,
    );
    for (const c of p.changes) console.log(`     + ${c}`);
    for (const problem of p.problems) console.log(`     ! ${problem}`);
  }

  const todo = plans.filter((p) => p.action === "create" || p.action === "update");
  if (!apply) {
    console.log(`\nDry run: ${todo.length} slot(s) would change. Nothing was written. Rerun with --apply.`);
    return;
  }
  for (const plan of todo) {
    await applyPlan(plan, reserve);
    console.log(`  slot ${plan.n}: ${plan.action}d`);
  }
  console.log(`\nApplied: ${todo.length} slot(s) changed.`);
}

main()
  .catch((error) => {
    console.error(`slots:register failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
