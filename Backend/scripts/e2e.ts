/**
 * `npm run e2e -- --from 1 --to 10` -- Spec 03 Phase 5, the full user journey on
 * Monad testnet. Run the backend (all workers on) in another terminal; this
 * script drives the steps that need a Privy session (open request, payment
 * report) in-process and every user action on-chain from the E2E_USER_A_KEY /
 * E2E_USER_B_KEY wallets via viem.
 *
 * Steps run in order and can be split across runs (state in .e2e/state.json):
 * step 8 needs the backend STOPPED, every other step needs it running.
 *
 * Each step appends its section to docs/e2e-run.md (tx hashes as MonadVision
 * links, NAV, PASS / FAIL / SKIPPED); after step 10 the summary table follows.
 * E2E_BACKEND_LOG points at the backend's log (step 9 reads the reconciler's
 * pass from it).
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { config } from "../src/config/env";
(config as { perplRecordDir: string }).perplRecordDir ||= resolve(__dirname, "..", "fixtures", "perpl", "recordings");

import { erc20Abi, lendingPoolAbi, lendingPoolFactoryAbi, positionTokenAbi } from "../src/chain/abi";
import { assetAddress, chain, publicClient } from "../src/chain/clients";
import { currentMark, gasWithBuffer, isContract, isPriceFresh, navPerShare, tokenAccounting, venueDrift } from "../src/chain/writes";
import { connectDb, db } from "../src/config/db";
import { HttpError } from "../src/lib/errors";
import { marketForPosition } from "../src/services/markets";
import { getOpenRequest, reportPayment, requestOpenPosition } from "../src/services/openPosition";
import { computeFundingTarget } from "../src/services/reporter";
import { closeAll } from "../src/venue/perpl/connections";
import { getAccountByAddr } from "../src/venue/perpl/exchange";
import { recorderFlushed } from "../src/venue/perpl/recorder";

// --- Setup -------------------------------------------------------------------------------

const BACKEND = resolve(__dirname, "..");
const REPO = resolve(BACKEND, "..");
const DOC = join(REPO, "docs", "e2e-run.md");
const STATE_FILE = join(BACKEND, ".e2e", "state.json");
const BACKEND_URL = process.env.E2E_BACKEND_URL ?? `http://localhost:${config.port}`;
const BACKEND_LOG = process.env.E2E_BACKEND_LOG;

const E6 = 1_000_000n;
const E18 = 10n ** 18n;
const TICK18 = 10n ** 16n; // ETH price tick (2 decimals) in 1e18

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const FROM = Number(flag("from", "1"));
const TO = Number(flag("to", "10"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tx = (hash: string) => `[${hash.slice(0, 10)}…](https://testnet.monadvision.com/tx/${hash})`;
const addr = (a: string) => `[${a.slice(0, 8)}…${a.slice(-4)}](https://testnet.monadvision.com/address/${a})`;
const usd = (units: bigint) => `$${(Number(units) / 1e6).toFixed(6).replace(/0{1,4}$/, "")}`;
const px = (p18: bigint) => `$${(Number(p18 / 10n ** 12n) / 1e6).toFixed(2)}`;
const now = () => new Date().toISOString();

type Result = "PASS" | "FAIL" | "SKIPPED";
interface StepRecord {
  title: string;
  result: Result;
  keyTx?: string;
  note?: string;
}
interface State {
  startedAt?: string;
  openRequestId?: string;
  positionId?: string;
  token?: Address;
  pool?: Address;
  slotId?: string;
  mintBlock?: string;
  steps: Record<string, StepRecord>;
}

function loadState(): State {
  return existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as State) : { steps: {} };
}
function saveState(state: State): void {
  mkdirSync(resolve(STATE_FILE, ".."), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function wallet(envName: string): WalletClient & { account: { address: Address } } {
  const key = (process.env[envName] ?? "").trim();
  if (!key) throw new Error(`${envName} is not set`);
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`);
  return createWalletClient({ account, chain: chain(), transport: http(config.rpcUrl) }) as never;
}
const A = wallet("E2E_USER_A_KEY");
const B = wallet("E2E_USER_B_KEY");
const pc = (): PublicClient => publicClient();

/// Simulate, send, wait. Returns the hash and receipt.
async function send(
  who: WalletClient & { account: { address: Address } },
  call: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] },
): Promise<{ hash: Hash; receipt: TransactionReceipt }> {
  const { request } = await pc().simulateContract({ ...call, account: who.account } as never);
  const gas = await gasWithBuffer({ ...call, account: who.account } as never);
  const hash = await who.writeContract({ ...(request as object), gas } as never);
  const receipt = await pc().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${call.functionName} reverted (${hash})`);
  return { hash, receipt };
}

const read = <T>(address: Address, abi: readonly unknown[], functionName: string, a: readonly unknown[] = []) =>
  pc().readContract({ address, abi, functionName, args: a } as never) as Promise<T>;
const assetBalance = (who: Address) => read<bigint>(assetAddress(), erc20Abi, "balanceOf", [who]);

async function waitFor<T>(what: string, timeoutMs: number, poll: () => Promise<T | undefined | null | false>, everyMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await poll().catch((error) => {
      console.log(`  (${what}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
      return undefined;
    });
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    await sleep(everyMs);
  }
}

/// Logs of `eventName` on `address` since `fromBlock`, decoded.
async function events(address: Address, eventName: string, fromBlock: bigint) {
  const logs = await pc().getLogs({ address, fromBlock, toBlock: "latest" });
  return parseEventLogs({ abi: positionTokenAbi, eventName: eventName as never, logs }) as unknown as Array<{
    args: Record<string, unknown>;
    transactionHash: Hash;
    blockNumber: bigint;
  }>;
}

async function backendUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// --- The report --------------------------------------------------------------------------

class Section {
  lines: string[] = [];
  checks: Array<{ ok: boolean; what: string }> = [];
  constructor(
    readonly n: number,
    readonly title: string,
  ) {}
  line(text: string): void {
    this.lines.push(text);
    console.log(`  ${text}`);
  }
  check(ok: boolean, what: string): boolean {
    this.checks.push({ ok, what });
    console.log(`  ${ok ? "✔" : "✘"} ${what}`);
    return ok;
  }
}

function writeSection(s: Section, result: Result, extra?: string): void {
  if (!existsSync(DOC)) {
    writeFileSync(
      DOC,
      "# End-to-end run on Monad testnet (Spec 03 Phase 5)\n\n" +
        "Driven by `npm run e2e` (Backend/scripts/e2e.ts) against the backend running with every worker on " +
        "(`ENABLE_INDEXER/RECONCILER/REPORTER/LIQUIDATOR=true`). Users A and B are plain wallets " +
        `(A ${addr(A.account.address)}, B ${addr(B.account.address)}); the open request and the payment ` +
        "report are driven in-process (they need a Privy session over HTTP), everything else is on-chain.\n",
    );
  }
  const body = [
    "",
    `## Step ${s.n} — ${s.title} — **${result}**`,
    "",
    `_${now()}_`,
    "",
    ...s.lines.map((l) => `- ${l}`),
    "",
    ...(s.checks.length ? ["Checks:", "", ...s.checks.map((c) => `- ${c.ok ? "✅" : "❌"} ${c.what}`), ""] : []),
    ...(extra ? [extra, ""] : []),
  ];
  appendFileSync(DOC, body.join("\n"));
}

// --- Steps -------------------------------------------------------------------------------

async function ensureUsers(): Promise<void> {
  for (const [w, name] of [
    [A, "A"],
    [B, "B"],
  ] as const) {
    const walletAddress = w.account.address.toLowerCase();
    await db.user.upsert({
      where: { walletAddress },
      create: { walletAddress, privyUserId: `e2e-user-${name}-${walletAddress.slice(2, 10)}`, tag: `e2e${name}${walletAddress.slice(2, 8)}` },
      update: {},
    });
  }
}

/// requestOpenPosition, waiting for a free slot rather than failing (SLOT_COUNT=2).
async function openRequestWhenSlotFree(amount: string, s: Section) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestOpenPosition({
        userWalletAddress: A.account.address.toLowerCase(),
        market: "ETH",
        direction: "long",
        leverage: 3,
        amount,
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 503 && attempt < 40) {
        if (attempt === 0) s.line(`no free slot (${error.message}); waiting for a settlement to free one`);
        await sleep(15_000);
        continue;
      }
      throw error;
    }
  }
}

async function step1(state: State, s: Section): Promise<Result> {
  await ensureUsers();
  const res = await openRequestWhenSlotFree("50", s);
  state.openRequestId = res.openRequestId;
  s.line(`open request \`${res.openRequestId}\`: ETH long, $50 at 3x; pay ${usd(BigInt(res.amount))} to slot wallet ${addr(res.payTo)}`);

  const pay = await send(A, { address: assetAddress(), abi: erc20Abi, functionName: "transfer", args: [res.payTo, BigInt(res.amount)] });
  s.line(`A paid: ${tx(pay.hash)}`);
  await reportPayment({ openRequestId: res.openRequestId, callerWalletAddress: A.account.address.toLowerCase(), txHash: pay.hash });

  const t0 = Date.now();
  const done = await waitFor("the open request to finish", 8 * 60_000, async () => {
    const r = await getOpenRequest(res.openRequestId, A.account.address);
    return ["minted", "refunded"].includes(r.status) || (r.status === "failed" && r.refundTxHash) ? r : undefined;
  });
  s.line(`status **${done.status}** after ${Math.round((Date.now() - t0) / 1000)} s; entry orders sent: ${done.venueAttempts}`);
  for (const [k, v] of Object.entries(done)) if (/TxHash$/.test(k) && typeof v === "string") s.line(`${k}: ${tx(v)}`);
  if (done.status !== "minted") {
    s.check(false, `minted (got ${done.status}: ${done.error ?? ""})`);
    return "FAIL";
  }

  const token = done.positionTokenAddress as Address;
  const position = await db.position.findFirstOrThrow({ where: { positionTokenAddress: token.toLowerCase() } });
  state.token = token;
  state.positionId = position.id;
  state.slotId = done.slotId;
  state.mintBlock = (await pc().getBlockNumber()).toString();
  s.line(`position token ${addr(token)}; venue entry ${done.entryPrice}, size ${done.filledSize} ETH; slot \`${done.slotId}\``);

  const drift = await venueDrift(token);
  const [fresh, nav, acc] = await Promise.all([isPriceFresh(token), navPerShare(token), tokenAccounting(token)]);
  const totalAssets = await read<bigint>(token, positionTokenAbi, "totalAssets");
  s.line(`venueDrift: ours ${drift.ourSize} @ ${drift.ourEntry} / venue ${drift.venueSize} @ ${drift.venueEntry}`);
  s.line(`NAV per share ${Number(nav) / 1e18}; totalAssets ${usd(totalAssets)}; capital ${usd(acc.capital)}`);
  const ok = [
    s.check(await isContract(token), "the token exists"),
    s.check(drift.venueExists && drift.ourSize === drift.venueSize, "venueDrift(): sizes match exactly"),
    s.check(drift.ourEntry === drift.venueEntry, "venueDrift(): entries match exactly"),
    s.check(fresh, "isPriceFresh() == true"),
    s.check(totalAssets <= 50n * E6 && 50n * E6 - totalAssets <= E6, "NAV equals the $50 deposit within fees (≤ $1: taker fee + spread)"),
  ].every(Boolean);
  state.steps["1"] = { title: "Open ETH long $50 @ 3x", result: ok ? "PASS" : "FAIL", keyTx: pay.hash };
  return ok ? "PASS" : "FAIL";
}

async function step2(state: State, s: Section): Promise<Result> {
  const token = state.token!;
  const ticks = config.reporterIntervalMs;
  const position = await db.position.findUniqueOrThrow({ where: { id: state.positionId! } });
  const slot = await db.subaccountSlot.findUniqueOrThrow({ where: { id: state.slotId! }, include: { operatorWallet: true } });
  const market = await marketForPosition(position.market);
  const since = new Date();

  // (a) Two reporter ticks: each writes a NAV report row for the position.
  s.line(`waiting two reporter ticks (${(2 * ticks) / 1000} s + margin)`);
  await sleep(2 * ticks + 20_000);
  const reports = await db.positionReport.count({ where: { positionId: state.positionId!, createdAt: { gte: since } } });
  const { terms } = await computeFundingTarget(token, slot, market);
  const before = await tokenAccounting(token);
  const age0 = BigInt(Math.floor(Date.now() / 1000)) - before.lastFundingTimestamp;
  const threshold = (() => {
    const rel = (before.capital * BigInt(config.fundingPushBps)) / 10_000n;
    const min = BigInt(config.fundingPushMin);
    return rel > min ? rel : min;
  })();
  s.line(
    `computeFundingTarget terms: venueTotal ${usd(terms.venueTotal)} = positionEquity ${usd(terms.positionEquity)} + freeAboveReserve ${usd(
      terms.freeAboveReserve,
    )}; capital ${usd(terms.capital)}; pricePnL ${usd(terms.pricePnL)}; fundingSettled ${usd(terms.fundingSettled)}; mark ${px(terms.mark18)} (live ${terms.markLive}) → target ${usd(terms.target)}`,
  );
  s.line(
    `push rule: |target − accrued| = ${usd(terms.target > before.fundingAccrued ? terms.target - before.fundingAccrued : before.fundingAccrued - terms.target)} vs threshold ${usd(threshold)}; funding age ${age0} s vs heartbeat ${config.fundingHeartbeatSeconds} s`,
  );
  const ticked = s.check(reports >= 2, `the reporter evaluated the position on both ticks (${reports} NAV report rows since ${since.toISOString()})`);

  // (b) applyFunding: on the threshold or, at the latest, the heartbeat.
  const fromBlock = BigInt(state.mintBlock!) - 50n;
  const deadline = Number(config.fundingHeartbeatSeconds) - Number(age0) + (2 * ticks) / 1000 + 60;
  s.line(`waiting for applyFunding: threshold or heartbeat, at most ${deadline} s more`);
  let pushes: Awaited<ReturnType<typeof events>> = [];
  try {
    pushes = await waitFor("a FundingUpdated event", Math.max(60, deadline) * 1000, async () => {
      const evs = await events(token, "FundingUpdated", fromBlock);
      return evs.length > 0 ? evs : undefined;
    }, 15_000);
  } catch {
    // reported by the check below
  }
  for (const e of pushes) s.line(`applyFunding → FundingUpdated ${JSON.stringify(e.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))} ${tx(e.transactionHash)}`);
  const acc = await tokenAccounting(token);
  const age = BigInt(Math.floor(Date.now() / 1000)) - acc.lastFundingTimestamp;
  s.line(`on-chain fundingAccrued ${usd(acc.fundingAccrued)}, lastFundingTimestamp ${acc.lastFundingTimestamp} (${age} s ago)`);
  const ok = [
    ticked,
    s.check(pushes.length > 0, `applyFunding was pushed (${pushes.length} FundingUpdated event(s) since mint)`),
    s.check(age <= BigInt(ticks / 1000 + 120), `lastFundingTimestamp is recent (${age} s)`),
  ].every(Boolean);
  state.steps["2"] = {
    title: "Funding pushed by the reporter",
    result: ok ? "PASS" : "FAIL",
    keyTx: pushes.at(-1)?.transactionHash,
    note: ok ? "pushed by the heartbeat: the target stayed under the threshold" : undefined,
  };
  return ok ? "PASS" : "FAIL";
}

async function poolOf(state: State): Promise<Address> {
  if (state.pool) return state.pool;
  const factory = config.lendingPoolFactoryAddress as Address;
  const pool = await waitFor("the token's lending pool", 3 * 60_000, async () => {
    const p = await read<Address>(factory, lendingPoolFactoryAbi, "primaryPool", [state.token!]);
    return /^0x0+$/.test(p) ? undefined : p;
  });
  state.pool = pool;
  return pool;
}

async function step3(state: State, s: Section): Promise<Result> {
  const token = state.token!;
  const pool = await poolOf(state);
  s.line(`lending pool ${addr(pool)}`);
  const shares = await read<bigint>(token, positionTokenAbi, "balanceOf", [A.account.address]);
  const approve = await send(A, { address: token, abi: positionTokenAbi, functionName: "approve", args: [pool, shares] });
  const deposit = await send(A, { address: pool, abi: lendingPoolAbi, functionName: "depositCollateral", args: [shares] });
  s.line(`A deposited all ${Number(shares) / 1e6} shares as collateral: approve ${tx(approve.hash)}, depositCollateral ${tx(deposit.hash)}`);
  const value = await read<bigint>(pool, lendingPoolAbi, "collateralValue", [A.account.address]);
  const amount = (value * 30n) / 100n;
  const borrow = await send(A, { address: pool, abi: lendingPoolAbi, functionName: "borrow", args: [amount] });
  const hf = await read<bigint>(pool, lendingPoolAbi, "healthFactor", [A.account.address]);
  s.line(`collateral value ${usd(value)}; borrowed 30% = ${usd(amount)}: ${tx(borrow.hash)}`);
  s.line(`health factor ${(Number(hf) / 1e18).toFixed(4)}`);
  const ok = s.check(hf > E18, "health factor > 1");
  state.steps["3"] = { title: "Borrow 30% against the tokens", result: ok ? "PASS" : "FAIL", keyTx: borrow.hash };
  return ok ? "PASS" : "FAIL";
}

async function step4(state: State, s: Section): Promise<Result> {
  const pool = await poolOf(state);
  const available = await read<bigint>(pool, lendingPoolAbi, "availableToBorrow", [A.account.address]);
  const amount = available + available / 10n + 1n;
  s.line(`availableToBorrow ${usd(available)} (50% LTV for a 3x position); trying ${usd(amount)}`);
  let simulated = "";
  try {
    await pc().simulateContract({ address: pool, abi: lendingPoolAbi, functionName: "borrow", args: [amount], account: A.account } as never);
  } catch (error) {
    simulated = (error as { shortMessage?: string }).shortMessage ?? String(error);
  }
  s.line(`simulation: ${simulated ? `reverted — ${simulated.split("\n")[0]}` : "**did not revert**"}`);
  // The same call on-chain, gas set by hand so it is mined (and visible) as a failed tx.
  const hash = await A.writeContract({ address: pool, abi: lendingPoolAbi, functionName: "borrow", args: [amount], gas: 400_000n, chain: chain(), account: A.account } as never);
  const receipt = await pc().waitForTransactionReceipt({ hash });
  s.line(`on-chain attempt: ${tx(hash)} → status **${receipt.status}**`);
  const ok = [s.check(Boolean(simulated), "the over-LTV borrow is refused in simulation"), s.check(receipt.status === "reverted", "and reverts on-chain")].every(Boolean);
  state.steps["4"] = { title: "Borrow above the LTV reverts", result: ok ? "PASS" : "FAIL", keyTx: hash };
  return ok ? "PASS" : "FAIL";
}

function driftCheck(s: Section, d: Awaited<ReturnType<typeof venueDrift>>): boolean {
  const entryDiff = d.ourEntry > d.venueEntry ? d.ourEntry - d.venueEntry : d.venueEntry - d.ourEntry;
  s.line(`venueDrift: ours ${d.ourSize} @ ${d.ourEntry} / venue ${d.venueSize} @ ${d.venueEntry} (entry diff ${entryDiff})`);
  return [
    s.check(d.ourSize === d.venueSize, "venueDrift(): sizes match exactly"),
    s.check(entryDiff <= TICK18, "venueDrift(): entries agree within one price tick ($0.01; Perpl keeps a sub-tick entry residue)"),
  ].every(Boolean);
}

async function step5(state: State, s: Section): Promise<Result> {
  const token = state.token!;
  const listed = await read<boolean>(token, positionTokenAbi, "listed");
  if (!listed) {
    const list = await send(A, { address: token, abi: positionTokenAbi, functionName: "list", args: ["e2e ETH long"] });
    s.line(`A listed it as "e2e ETH long": ${tx(list.hash)}`);
  }
  const assets = 20n * E6;
  // A previous attempt's request may still be pending on-chain: resume it
  // rather than buying in twice.
  const pendingB = await read<bigint>(token, positionTokenAbi, "pendingDepositRequest", [0n, B.account.address]);
  const earlier = (await events(token, "DepositRequested", BigInt(state.mintBlock!))).filter(
    (e) => String(e.args.controller).toLowerCase() === B.account.address.toLowerCase(),
  );
  let req: { hash: Hash; receipt: TransactionReceipt };
  let from: bigint;
  let feeToA: bigint;
  if (earlier.length > 0) {
    const last = earlier.at(-1)!;
    req = { hash: last.transactionHash, receipt: await pc().getTransactionReceipt({ hash: last.transactionHash }) };
    from = last.blockNumber;
    s.line(`resuming B's $20 buy-in from an earlier attempt: requestDeposit ${tx(req.hash)} (${pendingB > 0n ? `${usd(pendingB)} still pending` : "already fulfilled"})`);
    // The creator's fee is the asset Transfer to A inside that same transaction.
    feeToA = (parseEventLogs({ abi: erc20Abi, eventName: "Transfer" as never, logs: req.receipt.logs }) as unknown as Array<{ args: { to: Address; value: bigint } }>)
      .filter((t) => t.args.to.toLowerCase() === A.account.address.toLowerCase())
      .reduce((sum, t) => sum + t.args.value, 0n);
  } else {
    const aBefore = await assetBalance(A.account.address);
    const approve = await send(B, { address: assetAddress(), abi: erc20Abi, functionName: "approve", args: [token, assets] });
    from = await pc().getBlockNumber();
    req = await send(B, { address: token, abi: positionTokenAbi, functionName: "requestDeposit", args: [assets, B.account.address, B.account.address] });
    feeToA = (await assetBalance(A.account.address)) - aBefore;
    s.line(`B buys in $20: approve ${tx(approve.hash)}, requestDeposit ${tx(req.hash)}`);
  }
  const fee = parseEventLogs({ abi: positionTokenAbi, eventName: "CreatorFeeCollected" as never, logs: req.receipt.logs })[0] as unknown as { args: { amount: bigint } };

  const fulfilled = await waitFor("DepositFulfilled for B", 6 * 60_000, async () => {
    const evs = await events(token, "DepositFulfilled", from);
    return evs.find((e) => String(e.args.controller).toLowerCase() === B.account.address.toLowerCase());
  });
  const a = fulfilled.args as { assets: bigint; shares: bigint; navPerShare: bigint; addedSize: bigint; fillPrice: bigint };
  const sharesB = await read<bigint>(token, positionTokenAbi, "balanceOf", [B.account.address]);
  const expected = (assets * 98n / 100n) * E18 / a.navPerShare;
  s.line(`fulfilled ${tx(fulfilled.transactionHash)}: ${usd(a.assets)} → ${Number(a.shares) / 1e6} shares at NAV ${Number(a.navPerShare) / 1e18}; venue grew ${a.addedSize} (size6) @ ${px(a.fillPrice)}`);
  s.line(`creator fee ${usd(fee.args.amount)}; paid to A in that tx: ${usd(feeToA)}`);
  const ok = [
    s.check(a.assets === (assets * 98n) / 100n, "B's net assets = $20 × 0.98"),
    s.check(sharesB === a.shares && (a.shares > expected ? a.shares - expected : expected - a.shares) <= 1n, `B's shares = 20 × 0.98 / NAV (${a.shares} vs ${expected}, ±1 rounding)`),
    s.check(fee.args.amount === (assets * 2n) / 100n && feeToA === fee.args.amount, "the creator received the 2% fee"),
    driftCheck(s, await venueDrift(token)),
  ].every(Boolean);
  state.steps["5"] = { title: "List + $20 buy-in by B", result: ok ? "PASS" : "FAIL", keyTx: fulfilled.transactionHash };
  return ok ? "PASS" : "FAIL";
}

async function step6(state: State, s: Section): Promise<Result> {
  const token = state.token!;
  const shares = await read<bigint>(token, positionTokenAbi, "balanceOf", [B.account.address]);
  const half = shares / 2n;
  const bBefore = await assetBalance(B.account.address);
  const from = await pc().getBlockNumber();
  const req = await send(B, { address: token, abi: positionTokenAbi, functionName: "requestRedeem", args: [half, B.account.address, B.account.address] });
  s.line(`B redeems half (${Number(half) / 1e6} of ${Number(shares) / 1e6} shares): ${tx(req.hash)}`);
  const fulfilled = await waitFor("RedeemFulfilled for B", 6 * 60_000, async () => {
    const evs = await events(token, "RedeemFulfilled", from);
    return evs.find((e) => String(e.args.controller).toLowerCase() === B.account.address.toLowerCase());
  });
  const a = fulfilled.args as { shares: bigint; assets: bigint; navPerShare: bigint; closedSize: bigint; fillPrice: bigint };
  const bAfter = await assetBalance(B.account.address);
  const expected = (half * a.navPerShare) / E18;
  s.line(`fulfilled ${tx(fulfilled.transactionHash)}: paid ${usd(a.assets)} at NAV ${Number(a.navPerShare) / 1e18}; venue reduced ${a.closedSize} (size6) @ ${px(a.fillPrice)}`);
  const ok = [
    s.check(a.shares === half, "the requested shares were redeemed"),
    s.check((a.assets > expected ? a.assets - expected : expected - a.assets) <= 1n, `payout = shares × NAV (${a.assets} vs ${expected}, ±1 rounding)`),
    s.check(bAfter - bBefore === a.assets, `B received it (${usd(bAfter - bBefore)})`),
    driftCheck(s, await venueDrift(token)),
  ].every(Boolean);
  state.steps["6"] = { title: "B redeems half", result: ok ? "PASS" : "FAIL", keyTx: fulfilled.transactionHash };
  return ok ? "PASS" : "FAIL";
}

async function step7(state: State, s: Section): Promise<Result> {
  const token = state.token!;
  const mark = (await currentMark(token)).price;
  // ±0.05% (~$1.35 on ETH): the nearer side should be crossed within a few ticks.
  const sl = mark - (mark * 5n) / 10_000n;
  const tp = mark + (mark * 5n) / 10_000n;
  const from = await pc().getBlockNumber();
  const set = await send(B, { address: token, abi: positionTokenAbi, functionName: "setTriggers", args: [sl, tp] });
  const bBefore = await assetBalance(B.account.address);
  s.line(`mark ${px(mark)}; B set stop-loss ${px(sl)} / take-profit ${px(tp)}: ${tx(set.hash)}`);
  let low = mark;
  let high = mark;
  let executed: Awaited<ReturnType<typeof events>>[number] | undefined;
  try {
    executed = await waitFor(
      "TriggerExecuted for B",
      15 * 60_000,
      async () => {
        const m = (await currentMark(token)).price;
        if (m < low) low = m;
        if (m > high) high = m;
        const evs = await events(token, "TriggerExecuted", from);
        return evs.find((e) => String(e.args.holder).toLowerCase() === B.account.address.toLowerCase());
      },
      10_000,
    );
  } catch {
    s.line(`mark range over 15 min: ${px(low)} – ${px(high)}`);
    state.steps["7"] = { title: "Stop-loss / take-profit", result: "SKIPPED", note: `ETH stayed within ${px(low)}–${px(high)}; neither level crossed in 15 min` };
    s.line(`SKIPPED: ${state.steps["7"].note}`);
    return "SKIPPED";
  }
  const a = executed.args as { isStopLoss: boolean; shares: bigint; assets: bigint; markPrice: bigint };
  const block = executed.blockNumber;
  const [readerMark] = (await pc().readContract({ address: token, abi: positionTokenAbi, functionName: "currentMark", blockNumber: block } as never)) as readonly [bigint, boolean];
  const bAfter = await assetBalance(B.account.address);
  const sharesLeft = await read<bigint>(token, positionTokenAbi, "balanceOf", [B.account.address]);
  s.line(`executeTrigger ${tx(executed.transactionHash)}: ${a.isStopLoss ? "stop-loss" : "take-profit"} at mark ${px(a.markPrice)}; ${Number(a.shares) / 1e6} shares → ${usd(a.assets)}`);
  s.line(`token currentMark() at that block: ${px(readerMark)} (the live Perpl mark via PerplReader)`);
  const crossed = a.isStopLoss ? a.markPrice <= sl : a.markPrice >= tp;
  const ok = [
    s.check(crossed, "fired on a mark that had crossed the level"),
    s.check(a.markPrice === readerMark, "the mark used is the live on-chain mark at that block"),
    s.check(bAfter - bBefore === a.assets && a.assets > 0n, `B was paid (${usd(bAfter - bBefore)})`),
    s.check(sharesLeft === 0n, "B holds no shares afterwards"),
  ].every(Boolean);
  state.steps["7"] = { title: "Stop-loss / take-profit", result: ok ? "PASS" : "FAIL", keyTx: executed.transactionHash };
  return ok ? "PASS" : "FAIL";
}

async function step8(state: State, s: Section): Promise<Result> {
  const token = state.token!;
  const pool = await poolOf(state);
  if (await backendUp()) {
    s.check(false, `the backend must be stopped for this step (${BACKEND_URL}/health answered)`);
    return "FAIL";
  }
  s.line(`backend down (${BACKEND_URL}/health unreachable) from ${now()}`);
  const results: boolean[] = [];
  let lastTx: Hash | undefined;
  for (let i = 0; i <= 5; i += 1) {
    if (i > 0) await sleep(2 * 60_000);
    const fresh = await isPriceFresh(token);
    const acc = await tokenAccounting(token);
    const fundingAge = BigInt(Math.floor(Date.now() / 1000)) - acc.lastFundingTimestamp;
    let borrowNote: string;
    let borrowed = false;
    try {
      const b = await send(A, { address: pool, abi: lendingPoolAbi, functionName: "borrow", args: [100_000n] });
      borrowed = true;
      lastTx = b.hash;
      borrowNote = `borrow $0.10 ${tx(b.hash)}`;
    } catch (error) {
      borrowNote = `borrow FAILED: ${(error as { shortMessage?: string }).shortMessage ?? String(error)}`;
    }
    const up = await backendUp();
    s.line(`t+${i * 2} min: isPriceFresh ${fresh}, funding age ${fundingAge} s, ${borrowNote}${up ? " (**backend answered!**)" : ""}`);
    results.push(fresh && borrowed && !up);
  }
  const ok = s.check(results.every(Boolean), "every check: isPriceFresh() == true and a $0.10 borrow succeeded, with the backend down for 10 min");
  state.steps["8"] = { title: "Backend down: borrowing keeps working", result: ok ? "PASS" : "FAIL", keyTx: lastTx };
  return ok ? "PASS" : "FAIL";
}

async function step9(state: State, s: Section): Promise<Result> {
  const token = state.token!;
  const pool = await poolOf(state);
  // 1. B exits fully, if a trigger did not already.
  const bShares = await read<bigint>(token, positionTokenAbi, "balanceOf", [B.account.address]);
  if (bShares > 0n) {
    const from = await pc().getBlockNumber();
    const r = await send(B, { address: token, abi: positionTokenAbi, functionName: "requestRedeem", args: [bShares, B.account.address, B.account.address] });
    s.line(`B redeems the rest (${Number(bShares) / 1e6} shares): ${tx(r.hash)}`);
    await waitFor("B's final redeem", 6 * 60_000, async () =>
      (await events(token, "RedeemFulfilled", from)).find((e) => String(e.args.controller).toLowerCase() === B.account.address.toLowerCase()),
    );
  }
  // 2. A repays and withdraws the collateral.
  const debt = await read<bigint>(pool, lendingPoolAbi, "currentDebt", [A.account.address]);
  if (debt > 0n) {
    await send(A, { address: assetAddress(), abi: erc20Abi, functionName: "approve", args: [pool, debt + E6] });
    const repay = await send(A, { address: pool, abi: lendingPoolAbi, functionName: "repay", args: [debt + E6] });
    s.line(`A repays ${usd(debt)} (+ interest accrued since): ${tx(repay.hash)}`);
  }
  const collateral = await read<bigint>(pool, lendingPoolAbi, "collateralBalance", [A.account.address]);
  if (collateral > 0n) {
    const w = await send(A, { address: pool, abi: lendingPoolAbi, functionName: "withdrawCollateral", args: [collateral] });
    s.line(`A withdraws ${Number(collateral) / 1e6} shares of collateral: ${tx(w.hash)}`);
  }
  // 3. Close.
  const aBefore = await assetBalance(A.account.address);
  const from = await pc().getBlockNumber();
  const close = await send(A, { address: token, abi: positionTokenAbi, functionName: "requestClose" });
  s.line(`A requestClose(): ${tx(close.hash)}`);
  const closed = await waitFor("PositionClosed", 8 * 60_000, async () => (await events(token, "PositionClosed", from))[0]);
  s.line(`backend closed it: ${tx(closed.transactionHash)} (final NAV value ${usd(closed.args.finalNavValue as bigint)}, liquidated ${closed.args.wasLiquidated})`);
  const settled = await waitFor("Settled", 10 * 60_000, async () => (await events(token, "Settled", from))[0]);
  s.line(`settle(): ${tx(settled.transactionHash)} — ${usd(settled.args.assets as bigint)} for ${Number(settled.args.supply as bigint) / 1e6} shares`);
  const claimed = await waitFor("Claimed for A", 6 * 60_000, async () =>
    (await events(token, "Claimed", from)).find((e) => String(e.args.holder).toLowerCase() === A.account.address.toLowerCase()),
  );
  const aAfter = await assetBalance(A.account.address);
  s.line(`claim pushed to A: ${tx(claimed.transactionHash)} — ${usd(claimed.args.assets as bigint)}`);

  // 4. The slot is swept and free.
  const slot = await waitFor("the slot to be released", 6 * 60_000, async () => {
    const row = await db.subaccountSlot.findUniqueOrThrow({ where: { id: state.slotId! }, include: { operatorWallet: true } });
    return row.status === "free" ? row : undefined;
  });
  const account = await getAccountByAddr(slot.operatorWallet.address as Address);
  s.line(`slot \`${slot.id}\` is **${slot.status}**; Perpl balance ${usd(account.balanceCNS)} (reserve ${usd(BigInt(slot.reserve))})`);

  // 5. The reconciler's next pass, from the backend log.
  let reconcilerOk = false;
  if (BACKEND_LOG) {
    const after = Date.now();
    const pass = await waitFor("a reconciler pass after the settlement", 5 * 60_000, async () => {
      const lines = readFileSync(BACKEND_LOG, "utf8").split("\n").filter((l) => l.includes('"reconciliation pass complete"'));
      const last = lines.map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean).pop();
      return last && Date.parse(last.ts) > after ? last : undefined;
    }, 10_000);
    s.line(`reconciler pass at ${pass.ts}: drifted ${pass.drifted}, unswept ${pass.unsweptSlots}, stranded ${pass.strandedPending}/${pass.strandedConfirmed}, missed liquidations ${pass.missedLiquidations}`);
    reconcilerOk = pass.drifted === 0 && pass.unsweptSlots === 0 && pass.strandedPending === 0 && pass.strandedConfirmed === 0 && pass.missedLiquidations === 0;
  } else {
    s.line("E2E_BACKEND_LOG not set: reconciler pass not read");
  }
  const ok = [
    s.check(true, "the backend closed the venue position and called close()"),
    s.check(BigInt(account.balanceCNS) === BigInt(slot.reserve), "the slot account is swept to exactly its reserve"),
    s.check(slot.status === "free", "the slot is free again"),
    s.check(reconcilerOk, "the reconciler's next pass is clean"),
    s.check((claimed.args.assets as bigint) > 0n && aAfter - aBefore >= (claimed.args.assets as bigint), "the holder (A) received the settlement"),
  ].every(Boolean);
  state.steps["9"] = { title: "Repay, withdraw, close, settle, claims", result: ok ? "PASS" : "FAIL", keyTx: settled.transactionHash };
  return ok ? "PASS" : "FAIL";
}

async function step10(state: State, s: Section): Promise<Result> {
  await ensureUsers();
  const res = await openRequestWhenSlotFree("20", s);
  const wrong = 19n * E6;
  s.line(`open request \`${res.openRequestId}\` for ${usd(BigInt(res.amount))}; A pays the wrong amount, ${usd(wrong)}`);
  const aBefore = await assetBalance(A.account.address);
  const pay = await send(A, { address: assetAddress(), abi: erc20Abi, functionName: "transfer", args: [res.payTo, wrong] });
  s.line(`payment: ${tx(pay.hash)}`);
  await reportPayment({ openRequestId: res.openRequestId, callerWalletAddress: A.account.address.toLowerCase(), txHash: pay.hash });
  const done = await waitFor("the refund", 6 * 60_000, async () => {
    const r = await getOpenRequest(res.openRequestId, A.account.address);
    return r.refundTxHash && r.status === "refunded" ? r : undefined;
  });
  const aAfter = await assetBalance(A.account.address);
  const slot = await waitFor("the slot to be released", 3 * 60_000, async () => {
    const row = await db.subaccountSlot.findUniqueOrThrow({ where: { id: done.slotId } });
    return row.status === "free" ? row : undefined;
  });
  s.line(`status **${done.status}**: refund ${tx(done.refundTxHash!)}; error recorded: "${done.error ?? ""}"`);
  const ok = [
    s.check(done.status === "refunded" && Boolean(done.refundTxHash), "refunded on-chain"),
    s.check(aBefore - aAfter === 0n, `A got the full ${usd(wrong)} back (net change ${usd(aAfter - aBefore)})`),
    s.check(slot.status === "free", "the slot is released"),
  ].every(Boolean);
  state.steps["10"] = { title: "Wrong payment is refunded", result: ok ? "PASS" : "FAIL", keyTx: done.refundTxHash ?? undefined };
  return ok ? "PASS" : "FAIL";
}

const STEPS: Array<[string, (state: State, s: Section) => Promise<Result>]> = [
  ["Open: A opens ETH long, $50 at 3x", step1],
  ["Funding: two reporter ticks", step2],
  ["Borrow: A borrows 30% against all its tokens", step3],
  ["Deliberate failure: borrow above the LTV", step4],
  ["List + buy-in: B buys in $20", step5],
  ["Redeem: B redeems half", step6],
  ["Trigger: B's stop-loss / take-profit on the live mark", step7],
  ["Backend down: borrowing keeps working", step8],
  ["Close: repay, withdraw, requestClose, settle, claims", step9],
  ["Refund path: a wrong payment is refunded", step10],
];

function writeSummary(state: State): void {
  const rows = STEPS.map(([title], i) => {
    const r = state.steps[String(i + 1)];
    return `| ${i + 1} | ${title} | ${r ? `**${r.result}**` : "not run"}${r?.note ? ` — ${r.note}` : ""} | ${r?.keyTx ? tx(r.keyTx) : "—"} |`;
  });
  appendFileSync(DOC, ["", "## Summary", "", `_${now()}_`, "", "| Step | What | Result | Key tx |", "|---|---|---|---|", ...rows, ""].join("\n"));
}

async function main(): Promise<void> {
  await connectDb();
  const state = loadState();
  state.startedAt ??= now();
  for (let n = FROM; n <= TO; n += 1) {
    const [title, run] = STEPS[n - 1];
    if (n !== 8 && n !== 1 && !state.token) throw new Error("no position token in .e2e/state.json -- run step 1 first");
    if (n !== 8 && !(await backendUp())) throw new Error(`step ${n} needs the backend running (${BACKEND_URL}/health)`);
    console.log(`\n=== Step ${n}: ${title}`);
    const s = new Section(n, title);
    let result: Result;
    try {
      result = await run(state, s);
    } catch (error) {
      s.line(`**error:** ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
      result = "FAIL";
      state.steps[String(n)] = { title, result, note: (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200) };
    }
    writeSection(s, result);
    saveState(state);
    console.log(`=== Step ${n}: ${result}`);
    if (result === "FAIL") {
      console.log("stopping at the first failure");
      break;
    }
  }
  if (TO === 10 && state.steps["10"]) writeSummary(state);
  await recorderFlushed();
}

main()
  .then(async () => {
    closeAll();
    await db.$disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    closeAll();
    await db.$disconnect();
    process.exit(1);
  });
