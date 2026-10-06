/**
 * `npm run soak` -- Spec 03 Phase 6: two positions (one per slot) held open for
 * SOAK_MINUTES (default 60) with every backend worker running, then closed
 * through the normal flow. Samples /health/ready and each token's on-chain
 * funding age every minute; at the end reads the backend log (SOAK_BACKEND_LOG)
 * for socket closes (with their event-loop delay), alerts and unhandled
 * errors, and appends a "Phase 6" section to docs/e2e-run.md.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createWalletClient, http, parseEventLogs, type Address, type Hash, type TransactionReceipt, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { erc20Abi, positionTokenAbi } from "../src/chain/abi";
import { assetAddress, chain, publicClient } from "../src/chain/clients";
import { gasWithBuffer, tokenAccounting } from "../src/chain/writes";
import { connectDb, db } from "../src/config/db";
import { config } from "../src/config/env";
import { getOpenRequest, reportPayment, requestOpenPosition } from "../src/services/openPosition";
import { closeAll } from "../src/venue/perpl/connections";
import { getAccountByAddr } from "../src/venue/perpl/exchange";

const REPO = resolve(__dirname, "..", "..");
const DOC = join(REPO, "docs", "e2e-run.md");
const LOG = process.env.SOAK_BACKEND_LOG!;
const MINUTES = Number(process.env.SOAK_MINUTES ?? 60);
const URL_ = `http://localhost:${config.port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tx = (h: string) => `[${h.slice(0, 10)}…](https://testnet.monadvision.com/tx/${h})`;
const usd = (u: bigint) => `$${(Number(u) / 1e6).toFixed(6)}`;
const now = () => new Date().toISOString();
const pc = () => publicClient();

type W = WalletClient & { account: { address: Address } };
function wallet(env: string): W {
  const k = (process.env[env] ?? "").trim();
  const account = privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`);
  return createWalletClient({ account, chain: chain(), transport: http(config.rpcUrl) }) as never;
}
const A = wallet("E2E_USER_A_KEY");
const B = wallet("E2E_USER_B_KEY");

async function send(who: W, call: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) {
  const { request } = await pc().simulateContract({ ...call, account: who.account } as never);
  const gas = await gasWithBuffer({ ...call, account: who.account } as never);
  const hash = await who.writeContract({ ...(request as object), gas } as never);
  const receipt: TransactionReceipt = await pc().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${call.functionName} reverted (${hash})`);
  return hash;
}

async function waitFor<T>(what: string, ms: number, poll: () => Promise<T | undefined | null | false>, every = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await poll().catch(() => undefined);
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

async function events(address: Address, eventName: string, fromBlock: bigint) {
  const logs = await pc().getLogs({ address, fromBlock, toBlock: "latest" });
  return parseEventLogs({ abi: positionTokenAbi, eventName: eventName as never, logs }) as unknown as Array<{
    args: Record<string, unknown>;
    transactionHash: Hash;
  }>;
}

interface Pos {
  label: string;
  creator: W;
  token: Address;
  slotId: string;
  payTx: string;
}

async function open(creator: W, label: string, market: string, direction: "long" | "short"): Promise<Pos> {
  const walletAddress = creator.account.address.toLowerCase();
  await db.user.upsert({
    where: { walletAddress },
    create: { walletAddress, privyUserId: `e2e-user-${label}-${walletAddress.slice(2, 10)}`, tag: `soak${walletAddress.slice(2, 8)}` },
    update: {},
  });
  const res = await requestOpenPosition({ userWalletAddress: walletAddress, market, direction, leverage: 2, amount: "20" });
  const payTx = await send(creator, { address: assetAddress(), abi: erc20Abi, functionName: "transfer", args: [res.payTo, BigInt(res.amount)] });
  await reportPayment({ openRequestId: res.openRequestId, callerWalletAddress: walletAddress, txHash: payTx });
  const done = await waitFor(`${label} minted`, 10 * 60_000, async () => {
    const r = await getOpenRequest(res.openRequestId, walletAddress);
    if (["refunded", "failed"].includes(r.status)) throw new Error(`${label}: ${r.status} ${r.error}`);
    return r.status === "minted" ? r : undefined;
  });
  console.log(`${label} minted: token ${done.positionTokenAddress}, slot ${done.slotId}`);
  return { label, creator, token: done.positionTokenAddress as Address, slotId: done.slotId, payTx };
}

async function close(p: Pos, sinceBlock?: bigint) {
  // Already closed (e.g. before a resumed finish): read its events instead.
  const alreadyClosed = await pc().readContract({ address: p.token, abi: positionTokenAbi, functionName: "closed" } as never) as boolean;
  const from = alreadyClosed && sinceBlock !== undefined ? sinceBlock : await pc().getBlockNumber();
  const req = alreadyClosed
    ? (await events(p.token, "CloseRequested", from))[0]?.transactionHash ?? ""
    : await send(p.creator, { address: p.token, abi: positionTokenAbi, functionName: "requestClose" });
  const closed = await waitFor(`${p.label} PositionClosed`, 10 * 60_000, async () => (await events(p.token, "PositionClosed", from))[0]);
  const settled = await waitFor(`${p.label} Settled`, 10 * 60_000, async () => (await events(p.token, "Settled", from))[0]);
  const claimed = await waitFor(`${p.label} Claimed`, 10 * 60_000, async () =>
    (await events(p.token, "Claimed", from)).find((e) => String(e.args.holder).toLowerCase() === p.creator.account.address.toLowerCase()),
  );
  const slot = await waitFor(`${p.label} slot free`, 10 * 60_000, async () => {
    const s = await db.subaccountSlot.findUniqueOrThrow({ where: { id: p.slotId }, include: { operatorWallet: true } });
    return s.status === "free" ? s : undefined;
  });
  const account = await getAccountByAddr(slot.operatorWallet.address as Address);
  return { req, closed: closed.transactionHash, settled: settled.transactionHash, claimed: claimed.transactionHash, assets: claimed.args.assets as bigint, swept: account.balanceCNS === BigInt(slot.reserve), free: slot.status === "free" };
}

function logLines(sinceMs: number, untilMs: number): Array<Record<string, unknown>> {
  return readFileSync(LOG, "utf8")
    .split("\n")
    .map((l) => {
      const i = l.indexOf("{");
      if (i < 0) return null;
      try {
        return JSON.parse(l.slice(i)) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((o): o is Record<string, unknown> => !!o && typeof o.ts === "string" && Date.parse(o.ts as string) >= sinceMs && Date.parse(o.ts as string) <= untilMs);
}

async function main() {
  await connectDb();
  const health = await fetch(`${URL_}/health`).then((r) => r.json()).catch(() => null);
  if (!health) throw new Error("backend not running");
  console.log("health", JSON.stringify(health));

  // Reuse positions already open (e.g. a soak cut short), else open two.
  // SOAK_TOKENS: the soak's two tokens, whatever their state now (a resumed finish).
  const pinned = (process.env.SOAK_TOKENS ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const existing = await db.position.findMany({
    where: pinned.length ? { positionTokenAddress: { in: pinned } } : { status: "open", positionTokenAddress: { not: null } },
    include: { subaccountSlot: true },
    orderBy: { createdAt: "asc" },
  });
  let positions: Pos[];
  if (existing.length >= 2) {
    positions = [];
    for (const p of existing.slice(0, 2)) {
      const creator = p.userWalletAddress.toLowerCase() === A.account.address.toLowerCase() ? A : B;
      // A settled position no longer holds its slot: the open request still names it.
      const slotId =
        p.subaccountSlot?.id ??
        (await db.positionOpenRequest.findFirstOrThrow({ where: { positionTokenAddress: p.positionTokenAddress } })).slotId;
      positions.push({ label: creator === A ? "A" : "B", creator, token: p.positionTokenAddress as Address, slotId, payTx: "" });
    }
    console.log(`reusing open positions: ${positions.map((p) => `${p.label} ${p.token}`).join(", ")}`);
  } else {
    positions = [await open(A, "A", "ETH", "long"), await open(B, "B", "BTC", "short")];
  }

  // SOAK_START (ISO): finish a soak that already ran from then until now
  // (cut short) -- no sampling loop; funding ages come from the backend log.
  const resumedFrom = process.env.SOAK_START ? Date.parse(process.env.SOAK_START) : undefined;
  const soakStart = resumedFrom ?? Date.now();
  const heartbeatLimit = config.fundingHeartbeatSeconds + config.reporterIntervalMs / 1000;
  const maxAge: Record<string, number> = {};
  const healthFails: string[] = [];
  let samples = 0;
  console.log(`soak started ${now()} for ${MINUTES} min`);
  while (resumedFrom === undefined && Date.now() - soakStart < MINUTES * 60_000) {
    await sleep(60_000);
    samples += 1;
    for (const p of positions) {
      const acc = await tokenAccounting(p.token).catch(() => null);
      if (!acc) continue;
      const age = Math.floor(Date.now() / 1000) - Number(acc.lastFundingTimestamp);
      maxAge[p.label] = Math.max(maxAge[p.label] ?? 0, age);
    }
    const ready = await fetch(`${URL_}/health/ready`, { signal: AbortSignal.timeout(20_000) })
      .then(async (r) => ({ status: r.status, body: await r.json() }))
      .catch((e) => ({ status: 0, body: String(e) }));
    if (ready.status !== 200) healthFails.push(`${now()} ${ready.status}`);
    if (samples % 10 === 0) console.log(`t+${samples} min: max funding age ${JSON.stringify(maxAge)}, /health/ready ${ready.status}`);
  }
  const soakEnd = Date.now();
  console.log(`soak ended ${now()}`);

  // --- The backend log over the soak window --------------------------------
  const lines = logLines(soakStart, soakEnd);
  const closes = lines.filter((l) => l.message === "trading socket closed");
  const bySlot: Record<string, number> = {};
  for (const c of closes) bySlot[String(c.slotId)] = (bySlot[String(c.slotId)] ?? 0) + 1;
  const alerts = lines.filter((l) => l.scope === "alert");
  const unhandled = lines.filter((l) => /unhandled|uncaught/i.test(String(l.message)));
  const errors = lines.filter((l) => l.level === "error" && l.scope !== "alert");
  // Funding age from the backend's own pushes: the longest gap between the
  // window's start (or a push) and the next push / the window's end.
  if (resumedFrom !== undefined) {
    const all = logLines(0, soakEnd);
    for (const p of positions) {
      const posId = (await db.position.findFirstOrThrow({ where: { positionTokenAddress: p.token.toLowerCase() } })).id;
      const pushes = all.filter((l) => l.message === "funding applied" && l.positionId === posId).map((l) => Date.parse(String(l.ts)));
      // Funding is only owed while the position is open: measure to its close.
      const closedAt = all.find((l) => l.message === "position closed on-chain; settling" && l.positionId === posId);
      const end = closedAt ? Math.min(soakEnd, Date.parse(String(closedAt.ts))) : soakEnd;
      const before = pushes.filter((t) => t <= soakStart).pop() ?? soakStart;
      const marks = [before, ...pushes.filter((t) => t > soakStart && t < end), end];
      let gap = 0;
      for (let i = 1; i < marks.length; i += 1) gap = Math.max(gap, marks[i] - marks[i - 1]);
      maxAge[p.label] = Math.round(gap / 1000);
    }
    const ready = await fetch(`${URL_}/health/ready`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.status).catch(() => 0);
    samples = 1;
    if (ready !== 200) healthFails.push(`${now()} ${ready}`);
  }

  // --- Close both through the normal flow ----------------------------------
  const closed = [];
  const sinceBlock = resumedFrom !== undefined
    ? (await pc().getBlockNumber()) - BigInt(Math.ceil(((Date.now() - soakStart) / 1000) * 4)) - 500n
    : undefined;
  for (const p of positions) closed.push({ p, r: await close(p, sinceBlock) });

  // --- Report ----------------------------------------------------------------
  const hours = (soakEnd - soakStart) / 3_600_000;
  const slotIds = positions.map((p) => p.slotId);
  const reconnectOk = slotIds.every((id) => (bySlot[id] ?? 0) <= 2 * Math.max(1, Math.round(hours)));
  const ageOk = positions.every((p) => (maxAge[p.label] ?? Infinity) < heartbeatLimit);
  const rows = [
    `| WS reconnects ≤ 2 per socket per hour | ${slotIds.map((id) => `slot \`${id.slice(-6)}\`: ${bySlot[id] ?? 0}`).join(", ")} | **${reconnectOk ? "PASS" : "FAIL"}** |`,
    `| Funding age always < FUNDING_HEARTBEAT_SECONDS + one tick (${heartbeatLimit} s) | ${positions.map((p) => `${p.label}: max ${maxAge[p.label]} s`).join(", ")} (sampled every minute on-chain) | **${ageOk ? "PASS" : "FAIL"}** |`,
    `| No reconciler / other alerts | ${alerts.length} alert line(s) | **${alerts.length === 0 ? "PASS" : "FAIL"}** |`,
    `| No unhandled errors | ${unhandled.length} unhandled; ${errors.length} other error-level line(s) | **${unhandled.length === 0 ? "PASS" : "FAIL"}** |`,
    `| /health/ready answered 200 every minute | ${samples - healthFails.length}/${samples} | **${healthFails.length === 0 ? "PASS" : "FAIL"}** |`,
  ];
  const closeRows = closes.map(
    (c) => `| ${c.ts} | \`${String(c.slotId).slice(-6)}\` | ${c.code} ${c.reason} | ${c.serverPings ?? "-"} | ${c.eventLoopMaxMs ?? "-"} | ${c.eventLoopP99Ms ?? "-"} |`,
  );
  const body = [
    "",
    resumedFrom !== undefined
      ? `## Phase 6 — soak, SHORTENED to ${((soakEnd - soakStart) / 60_000).toFixed(1)} min at the user's request (not the 1-hour soak) — ${now()}`
      : `## Phase 6 — 1-hour soak (2 positions, 2 slots) — ${now()}`,
    "",
    `Backend running with every worker on; ${((soakEnd - soakStart) / 60_000).toFixed(1)} min from ${new Date(soakStart).toISOString()} to ${new Date(soakEnd).toISOString()}.` +
      (resumedFrom !== undefined
        ? " The hour-based criteria below are evaluated over this shorter window only: a funding heartbeat cycle (30 min) and a full hour of reconnects were NOT observed. Funding age comes from the backend's `funding applied` log; /health/ready was checked once, at the end."
        : ""),
    "",
    ...positions.map((p) => `- ${p.label === "A" ? "A: ETH long" : "B: BTC short"}, $20 at 2x — token [${p.token.slice(0, 10)}…](https://testnet.monadvision.com/address/${p.token}), slot \`${p.slotId}\`${p.payTx ? `, payment ${tx(p.payTx)}` : " (opened 2026-10-05 20:44–20:47 UTC, reused)"}`),
    "",
    "| Criterion | Observed | Result |",
    "|---|---|---|",
    ...rows,
    "",
    "Trading-socket closes during the soak, with the event-loop delay since the previous close:",
    "",
    "| Time | Slot | Close | Server pings seen | Event-loop max (ms) | Event-loop p99 (ms) |",
    "|---|---|---|---|---|---|",
    ...(closeRows.length ? closeRows : ["| — | — | none | — | — | — |"]),
    "",
    ...(alerts.length ? ["Alerts:", "", ...alerts.slice(0, 20).map((a) => `- ${a.ts}: ${a.message} ${JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k]) => !["ts", "level", "scope", "message"].includes(k))))}`), ""] : []),
    ...(errors.length ? ["Error-level lines (not unhandled):", "", ...errors.slice(0, 20).map((e) => `- ${e.ts} [${e.scope}] ${e.message}: ${String(e.error ?? "").split("\n")[0].slice(0, 160)}`), ""] : []),
    "Closed through the normal flow afterwards:",
    "",
    ...closed.map(({ p, r }) => `- ${p.label}: requestClose ${tx(r.req)} → close ${tx(r.closed)} → settle ${tx(r.settled)} → claim ${tx(r.claimed)} (${usd(r.assets)}); slot swept to reserve: ${r.swept}, free: ${r.free}`),
    "",
  ];
  appendFileSync(DOC, body.join("\n"));
  console.log(body.join("\n"));
}

main()
  .then(async () => {
    closeAll();
    await db.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    closeAll();
    await db.$disconnect();
    process.exit(1);
  });
