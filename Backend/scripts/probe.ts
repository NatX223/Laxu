/**
 * `npm run probe -- <command> [--slot n] [--usd x] [--lev x]` -- live Perpl probes
 * on Monad testnet (Spec 03 Phase 2). Each command answers one or more of the
 * `VERIFY(spec03)` questions with recorded evidence: it prints a JSON result and
 * appends a section to docs/perpl-findings.md.
 *
 *   context                       /pub/context vs getExchangeInfo / token decimals / getMinAccountOpenCNS
 *   markets                       API initial/maintenance margin vs on-chain getMarginFractions
 *   slot      --slot n            GET /trading/wallet vs on-chain getAccountByAddr
 *   heartbeat --slot n            mt:19 sn and the first five mt:100 sn values
 *   open      --slot n --usd --lev  deposit + IOC OpenLong on ETH; frames, history latency, chain deltas
 *   equity    --slot n [--samples 3 --interval-s 300]  chain vs API equity over time
 *   add-margin --slot n --usd x   t:6 with `a` as a CNS integer, then as a human decimal
 *   increase  --slot n --usd x    add size; premiumPnlCNS before/after
 *   close     --slot n            IOC close, withdraw above the reserve, sweep to the float
 *
 * Every trading-WS frame and REST call is recorded (redacted) under
 * fixtures/perpl/recordings/ -- the evidence column cites file:line from there.
 * Tiny amounts only. Never prints a key or secret.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { relative, resolve, join } from "node:path";
import type { Address } from "viem";

import { assetDecimals, floatAddress, floatWallet, publicClient } from "../src/chain/clients";
import { assetBalanceOf, transferAsset } from "../src/chain/writes";
import { db } from "../src/config/db";
import { config } from "../src/config/env";
import { credentialsFor, slotWallet, type SlotWithWallet } from "../src/services/allocator";
import { toResolved, type ResolvedMarket } from "../src/services/markets";
import { raiseLastRequestId } from "../src/venue/requests";
import { venue } from "../src/venue/types";
import { OrderFlags, OrderType } from "../src/venue/perpl/config";
import { closeAll, ensure } from "../src/venue/perpl/connections";
import {
  getAccountByAddr,
  getMinAccountOpenCNS,
  getPosition,
  getWithdrawAllowanceData,
  readExchangeInfo,
} from "../src/venue/perpl/exchange";
import { redact } from "../src/venue/perpl/recorder";
import { getContext, getOrderHistory, getPositions, getWallet } from "../src/venue/perpl/rest";
import type { ApiOrder } from "../src/venue/perpl/types";
import type { OrderOutcome, OrderSide } from "../src/venue/types";
import { cnsToAsset, collateralScale, lotsToSize6, pnsToPrice18, size6ToLots } from "../src/venue/perpl/units";

// --- Setup: record everything, and observe heartbeat gaps rather than reconnect --------

const BACKEND = resolve(__dirname, "..");
const REPO = resolve(BACKEND, "..");
const FIXTURES = join(BACKEND, "fixtures", "perpl");
const RECORD_DIR = config.perplRecordDir ? resolve(config.perplRecordDir) : join(FIXTURES, "recordings");
const FINDINGS = join(REPO, "docs", "perpl-findings.md");
(config as { perplRecordDir: string }).perplRecordDir = RECORD_DIR;
(config as { perplHeartbeatGapReconnect: boolean }).perplHeartbeatGapReconnect = false;

const FULL_EXCHANGE_ABI = (() => {
  const file = JSON.parse(readFileSync(join(REPO, "Contracts", "abi", "perpl", "Exchange.json"), "utf8")) as unknown;
  return (Array.isArray(file) ? file : (file as { abi: unknown[] }).abi) as unknown[];
})();
const ERC20_DECIMALS_ABI = [
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
] as const;

const TX = (hash: string) => `[${hash.slice(0, 10)}…](https://testnet.monadvision.com/tx/${hash})`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

// --- Args ------------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
function flag(name: string, fallback?: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
}
const slotN = Number(flag("slot", "1"));

// --- Findings doc ---------------------------------------------------------------------

interface Row {
  verify: string;
  question: string;
  answer: string;
  evidence: string;
}

function appendFindings(title: string, rows: Row[], data: unknown): void {
  mkdirSync(resolve(FINDINGS, ".."), { recursive: true });
  if (!existsSync(FINDINGS)) {
    writeFileSync(
      FINDINGS,
      "# Perpl testnet findings (Spec 03 Phase 2)\n\n" +
        "Raw probe log: every `npm run probe` run appends a section below. Frame evidence is\n" +
        "`Backend/fixtures/perpl/recordings/<file>#L<line>` (redacted JSONL, one frame per line).\n",
    );
  }
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    "",
    `## ${title} — ${new Date().toISOString()}`,
    "",
    "| VERIFY | Question | Answer | Evidence |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${esc(r.verify)} | ${esc(r.question)} | ${esc(r.answer)} | ${esc(r.evidence)} |`),
    "",
    "<details><summary>raw result</summary>",
    "",
    "```json",
    json(data),
    "```",
    "",
    "</details>",
    "",
  ];
  appendFileSync(FINDINGS, lines.join("\n"));
}

// --- Recording-file helpers -----------------------------------------------------------

function recordingFile(slot: SlotWithWallet): string {
  return join(RECORD_DIR, `${slot.id}-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

function lineCount(file: string): number {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
}

interface RecordedLine {
  line: number;
  at: string;
  dir: "in" | "out";
  frame: Record<string, unknown>;
}

function linesAfter(file: string, after: number): RecordedLine[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((text, i) => ({ ...(JSON.parse(text) as Omit<RecordedLine, "line">), line: i + 1 }))
    .filter((entry) => entry.line > after);
}

function cite(file: string, lines: number[]): string {
  if (lines.length === 0) return `${relative(REPO, file).replace(/\\/g, "/")} (no lines)`;
  const sorted = [...lines].sort((a, b) => a - b);
  const range = sorted.length === 1 ? `L${sorted[0]}` : `L${sorted[0]}-L${sorted[sorted.length - 1]}`;
  return `${relative(REPO, file).replace(/\\/g, "/")}#${range}`;
}

/// The frames that belong to one order: the outgoing mt:22, its mt:3 ack (cid = frame sn),
/// and every mt:24/mt:27 entry carrying this rq.
function framesForRq(entries: RecordedLine[], rq: bigint): RecordedLine[] {
  const target = Number(rq);
  const out = entries.find((e) => e.dir === "out" && e.frame.mt === 22 && e.frame.rq === target);
  const frameSn = out?.frame.sn;
  // Frame sn restarts at 1 on every connection: the ack is the first mt:3 with that cid AFTER the send.
  const ack = out && entries.find((e) => e.line > out.line && e.frame.mt === 3 && e.frame.cid === frameSn);
  return entries.filter((e) => {
    if (e === out || e === ack) return true;
    const d = e.frame.d;
    return Array.isArray(d) && d.some((x) => (x as { rq?: number }).rq === target);
  });
}

function orderEventsOf(frames: RecordedLine[], rq: bigint): Array<Pick<ApiOrder, "st" | "sr" | "fr" | "fs" | "fp" | "os" | "f"> & { line: number; mt: number }> {
  const target = Number(rq);
  const events = [];
  for (const e of frames) {
    if (e.frame.mt !== 24 && e.frame.mt !== 23) continue;
    for (const o of (e.frame.d as ApiOrder[]) ?? []) {
      if (o.rq !== target) continue;
      events.push({ line: e.line, mt: e.frame.mt as number, st: o.st, sr: o.sr, fr: o.fr, fs: o.fs, fp: o.fp, os: o.os, f: o.f });
    }
  }
  return events;
}

// --- Loaders ---------------------------------------------------------------------------

/// Neon's direct host suspends when idle; its first connection after that often fails.
async function wakeDb(): Promise<void> {
  for (let i = 0; ; i += 1) {
    try {
      await db.$queryRaw`select 1`;
      return;
    } catch (error) {
      if (i >= 5) throw error;
      await sleep(3000);
    }
  }
}

async function loadSlot(n: number): Promise<SlotWithWallet> {
  await wakeDb();
  const slot = await db.subaccountSlot.findFirst({
    where: { apiSecretRef: { in: [`SLOT_${n}_API`, `SECRET_SLOT_${n}_API`] } },
    include: { operatorWallet: true },
  });
  if (!slot) throw new Error(`slot ${n} not found -- run npm run slots:provision`);
  if (slot.status !== "free") throw new Error(`slot ${n} is ${slot.status}; probes only touch a free slot`);
  return slot;
}

async function loadMarket(base: string): Promise<ResolvedMarket> {
  await wakeDb();
  const row = await db.market.findFirst({ where: { baseAsset: base } });
  if (!row) throw new Error(`market ${base} not synced -- run npm run db:seed`);
  return toResolved(row);
}

async function chainAccount(slot: SlotWithWallet) {
  const a = await getAccountByAddr(slot.operatorWallet.address as Address);
  return { accountId: a.accountId, balanceCNS: a.balanceCNS, lockedBalanceCNS: a.lockedBalanceCNS, frozen: a.frozen };
}

async function chainPosition(slot: SlotWithWallet, market: ResolvedMarket) {
  const { position, markPricePNS, markPriceValid } = await getPosition(BigInt(market.perpetualId), BigInt(slot.perplAccountId!));
  return { ...position, markPricePNS, markPriceValid };
}

async function apiAccount(slot: SlotWithWallet) {
  const wallet = await getWallet(credentialsFor(slot));
  const account = (wallet.as ?? []).find((a) => String(a.id) === slot.perplAccountId) ?? wallet.as?.[0];
  return { sn: wallet.sn, b: account?.b, lb: account?.lb, fw: account?.fw, lfr: account?.lfr, id: account?.id };
}

/// The next rq/lb exactly as a backend flow gets them, with the slot counter raised.
async function nextRequest(slot: SlotWithWallet, market: ResolvedMarket) {
  const req = await venue().nextRequest(slot, market);
  await db.$transaction((tx) => raiseLastRequestId(tx, slot.id, req.requestId));
  return req;
}

/// Wait until the on-chain position satisfies `done` (views can trail the WS by a block).
async function waitForPosition(slot: SlotWithWallet, market: ResolvedMarket, done: (p: Awaited<ReturnType<typeof chainPosition>>) => boolean) {
  for (let i = 0; i < 40; i += 1) {
    const p = await chainPosition(slot, market);
    if (done(p)) return p;
    await sleep(500);
  }
  return chainPosition(slot, market);
}

async function fundSlotWallet(slot: SlotWithWallet, amount: bigint): Promise<string | undefined> {
  const address = slot.operatorWallet.address as Address;
  const have = await assetBalanceOf(address);
  if (have >= amount) return undefined;
  return transferAsset(floatWallet(), address, amount - have);
}

/// Poll order-history every 250 ms until `rq` shows up; returns the latency from `t0`.
async function pollHistory(slot: SlotWithWallet, rq: bigint, t0: number, timeoutMs = 60_000) {
  const accountId = Number(slot.perplAccountId);
  let polls = 0;
  while (Date.now() - t0 < timeoutMs) {
    polls += 1;
    try {
      const page = await getOrderHistory(credentialsFor(slot), undefined, 20);
      const hits = (page.d ?? []).filter((o) => o.acc === accountId && o.rq === Number(rq));
      if (hits.length > 0) return { found: true, latencyMs: Date.now() - t0, polls, entries: hits };
    } catch (error) {
      // keep polling; record nothing secret
      void error;
    }
    await sleep(250);
  }
  return { found: false, latencyMs: null, polls, entries: [] as ApiOrder[] };
}

// --- Commands --------------------------------------------------------------------------

async function probeContext() {
  const context = await getContext();
  mkdirSync(FIXTURES, { recursive: true });
  const fixture = join(FIXTURES, "context.testnet.json");
  writeFileSync(fixture, json(redact(context)));

  const info = await readExchangeInfo();
  const tokenDecimals = Number(
    await publicClient().readContract({ address: info.collateralToken, abi: ERC20_DECIMALS_ABI, functionName: "decimals" }),
  );
  const minOnChain = await getMinAccountOpenCNS();
  const instance = context.instances[0];
  const apiToken = context.tokens.find((t) => t.id === instance?.collateral_token_id) ?? context.tokens[0];
  const rawMin = instance?.min_account_open_amount;
  const isInteger = /^\d+$/.test(String(rawMin));
  const equal = isInteger && BigInt(String(rawMin)) === minOnChain;
  const cnsDecimals = Number(info.collateralDecimals);

  const data = {
    collateralToken: info.collateralToken,
    configuredAsset: config.assetAddress,
    collateralDecimals: cnsDecimals,
    tokenDecimals,
    apiToken,
    instance,
    min_account_open_amount_raw: rawMin,
    getMinAccountOpenCNS: minOnChain,
    minAccountOpenHuman: `${Number(minOnChain) / 10 ** cnsDecimals}`,
  };
  const fixtureRel = relative(REPO, fixture).replace(/\\/g, "/");
  const rows: Row[] = [
    {
      verify: "—",
      question: "Collateral token and decimals",
      answer: `${info.collateralToken} (${apiToken?.symbol ?? "?"}); getExchangeInfo().collateralDecimals = ${cnsDecimals}; token decimals() = ${tokenDecimals}; ${
        info.collateralToken.toLowerCase() === config.assetAddress.toLowerCase() ? "matches ASSET_ADDRESS" : "**differs from ASSET_ADDRESS**"
      }`,
      evidence: `eth_call getExchangeInfo / decimals() on ${config.perplExchangeAddress}; ${fixtureRel}`,
    },
    {
      verify: "units.ts:75",
      question: "API `Amount` format (CNS integer vs human decimal)",
      answer: equal
        ? `CNS base-unit integer string: min_account_open_amount "${rawMin}" == getMinAccountOpenCNS() ${minOnChain} (= ${data.minAccountOpenHuman} ${apiToken?.symbol ?? ""} at ${cnsDecimals} dp)`
        : `**Not equal**: API "${rawMin}" vs on-chain ${minOnChain}`,
      evidence: `${fixtureRel} instances[0].min_account_open_amount; eth_call getMinAccountOpenCNS()`,
    },
  ];
  appendFindings("context", rows, data);
  return { rows, data };
}

async function probeMarkets() {
  const context = await getContext();
  const out: Record<string, unknown> = {};
  const rows: Row[] = [];
  for (const symbol of ["ETH", "BTC"]) {
    const m = context.markets.find((x) => x.symbol.toUpperCase().startsWith(symbol));
    if (!m) continue;
    const perpId = BigInt(m.perpetual_id);
    const perp = (await publicClient().readContract({
      address: config.perplExchangeAddress as Address,
      abi: FULL_EXCHANGE_ABI,
      functionName: "getPerpetualInfo",
      args: [perpId],
    })) as Record<string, unknown>;
    const fractions = (await publicClient().readContract({
      address: config.perplExchangeAddress as Address,
      abi: FULL_EXCHANGE_ABI,
      functionName: "getMarginFractions",
      args: [perpId, 0n],
    })) as readonly bigint[];
    const takerFee = (await publicClient().readContract({
      address: config.perplExchangeAddress as Address,
      abi: FULL_EXCHANGE_ABI,
      functionName: "getTakerFee",
      args: [perpId],
    })) as bigint;
    const [initHdths, maintHdths, dynInitHdths, oiMaxLNS] = fractions;
    out[symbol] = {
      api: {
        initial_margin: m.config.initial_margin,
        maintenance_margin: m.config.maintenance_margin,
        taker_fee: m.config.taker_fee,
        maker_fee: m.config.maker_fee,
        min_posting_amount: m.config.min_posting_amount,
      },
      chain: {
        getMarginFractions: { perpInitMarginFracHdths: initHdths, perpMaintMarginFracHdths: maintHdths, dynamicInitMarginFracHdths: dynInitHdths, oiMaxLNS },
        getPerpetualInfo: { marginTol: perp.marginTol, marginTolDecimals: perp.marginTolDecimals, priceDecimals: perp.priceDecimals, lotDecimals: perp.lotDecimals },
        getTakerFee: takerFee,
      },
      laxuMaxLeverage: Math.min(20, Math.floor(10_000 / m.config.initial_margin)),
    };
    rows.push({
      verify: "units.ts:171",
      question: `${symbol}: scale of initial_margin / maintenance_margin`,
      answer: `API initial_margin=${m.config.initial_margin}, maintenance_margin=${m.config.maintenance_margin}; chain getMarginFractions: init=${initHdths}, maint=${maintHdths} (Hdths), dynamicInit=${dynInitHdths}; getPerpetualInfo marginTol=${perp.marginTol} (decimals ${perp.marginTolDecimals}). Perpl UI max leverage: (fill in from UI)`,
      evidence: `/v1/pub/context markets[${m.id}].config; eth_call getMarginFractions(${perpId},0), getPerpetualInfo(${perpId})`,
    });
  }
  appendFindings("markets", rows, out);
  return { rows, data: out };
}

async function probeSlot() {
  const slot = await loadSlot(slotN);
  const [api, chain, scale] = await Promise.all([apiAccount(slot), chainAccount(slot), collateralScale()]);
  const data = { slot: slotN, accountId: slot.perplAccountId, api, chain, reserveAsset: slot.reserve, scale };
  const rows: Row[] = [
    {
      verify: "adapter.ts:98 (1/2)",
      question: "API wallet `b`/`lb` vs on-chain balanceCNS / lockedBalanceCNS",
      answer: `API b="${api.b}" lb="${api.lb}" fw=${api.fw} lfr=${api.lfr}; chain balanceCNS=${chain.balanceCNS} lockedBalanceCNS=${chain.lockedBalanceCNS}; ${
        String(api.b) === chain.balanceCNS.toString() && String(api.lb) === chain.lockedBalanceCNS.toString() ? "identical (CNS integers)" : "**differ**"
      }`,
      evidence: `GET /v1/trading/wallet (rest-*.jsonl); eth_call getAccountByAddr(${slot.operatorWallet.address})`,
    },
  ];
  appendFindings(`slot --slot ${slotN}`, rows, data);
  return { rows, data };
}

async function probeHeartbeat() {
  const slot = await loadSlot(slotN);
  const file = recordingFile(slot);
  const start = lineCount(file);
  const connection = ensure(slot);
  await connection.ready();
  const deadline = Date.now() + 120_000;
  let beats: RecordedLine[] = [];
  let snapshot: RecordedLine | undefined;
  while (Date.now() < deadline) {
    const entries = linesAfter(file, start).filter((e) => e.dir === "in");
    snapshot = entries.find((e) => e.frame.mt === 19);
    beats = entries.filter((e) => e.frame.mt === 100).slice(0, 5);
    if (snapshot && beats.length >= 5) break;
    await sleep(500);
  }
  closeAll();
  const snapSn = snapshot?.frame.sn as number | undefined;
  const beatSns = beats.map((b) => b.frame.sn as number);
  const beatHeads = beats.map((b) => b.frame.h as number | undefined);
  const consecutive = beatSns.every((sn, i) => i === 0 || sn === beatSns[i - 1] + 1);
  const seeded = snapSn !== undefined && beatSns[0] === snapSn + 1;
  const data = { snapshotSn: snapSn, beatSns, beatHeads, beatTimes: beats.map((b) => b.at), consecutive, seededFromSnapshot: seeded };
  const rows: Row[] = [
    {
      verify: "tradingWs.ts:471",
      question: "Is the first mt:100 `sn` == mt:19 `sn` + 1, and do heartbeats step by 1?",
      answer: `mt:19 sn=${snapSn}; first mt:100 sn=${beatSns.join(", ")}; first == snapshot+1: ${seeded}; consecutive: ${consecutive}; heads h=${beatHeads.join(", ")}`,
      evidence: cite(file, [snapshot?.line ?? 0, ...beats.map((b) => b.line)].filter(Boolean)),
    },
  ];
  appendFindings(`heartbeat --slot ${slotN}`, rows, data);
  return { rows, data };
}

interface Attempt {
  rq: bigint;
  lb: bigint;
  sentAt: number;
  result: string;
  lookups: number;
  error?: string;
}

/// Place an IOC exactly as a backend flow does, and when the socket gives no outcome, resolve
/// it the backend's way: findOrderOutcome until it is not `pending`; `not_placed` -> a new rq.
async function placeWithRecovery(
  slot: SlotWithWallet,
  market: ResolvedMarket,
  params: { side: OrderSide; size6: bigint; leverage: number },
  onSend?: (rq: bigint, sentAt: number) => void,
): Promise<{ outcome: OrderOutcome; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];
  for (let n = 0; n < 3; n += 1) {
    const req = await nextRequest(slot, market);
    const attempt: Attempt = { rq: req.requestId, lb: req.lastExecBlock, sentAt: Date.now(), result: "", lookups: 0 };
    attempts.push(attempt);
    onSend?.(req.requestId, attempt.sentAt);
    try {
      const outcome = await venue().placeMarketOrder(slot, { market, ...params, requestId: req.requestId, lastExecBlock: req.lastExecBlock });
      attempt.result = `ws:${outcome.status}`;
      return { outcome, attempts };
    } catch (error) {
      attempt.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    for (;;) {
      attempt.lookups += 1;
      const found = await venue().findOrderOutcome(slot, req.requestId, req.lastExecBlock, { market, kind: "ioc" });
      if (found === "pending") {
        await sleep(1000);
        continue;
      }
      if (found === "not_placed") {
        attempt.result = "lookup:not_placed";
        break;
      }
      attempt.result = `lookup:${found.status}`;
      return { outcome: found, attempts };
    }
  }
  throw new Error(`no outcome after ${attempts.length} attempts: ${json(attempts)}`);
}

/// Shared by open / increase: fund the wallet, deposit, IOC OpenLong.
async function openLong(slot: SlotWithWallet, market: ResolvedMarket, usd: number, lev: number) {
  const decimals = await assetDecimals();
  const amount = BigInt(Math.round(usd * 10 ** decimals));
  const fundTx = await fundSlotWallet(slot, amount);
  const accountBefore = await chainAccount(slot);
  const positionBefore = await chainPosition(slot, market);
  const depositTx = await venue().deposit(slot, amount);
  const accountAfterDeposit = await chainAccount(slot);

  // 95% of deposit x leverage, floored to the lot step: room for the taker fee.
  const mark18 = await venue().markPrice(market);
  const notional6 = (amount * BigInt(Math.round(lev * 100)) * 95n) / 10_000n;
  const lots = size6ToLots((notional6 * 10n ** 18n) / mark18, market.sizeDecimals);
  const size6 = lotsToSize6(lots, market.sizeDecimals);

  const file = recordingFile(slot);
  const start = lineCount(file);
  let history: ReturnType<typeof pollHistory> | undefined;
  let t0 = 0;
  const { outcome, attempts } = await placeWithRecovery(slot, market, { side: "open_long", size6, leverage: lev }, (rq, sentAt) => {
    t0 = sentAt;
    history = pollHistory(slot, rq, sentAt);
  });
  const req = { requestId: attempts[attempts.length - 1].rq, lastExecBlock: attempts[attempts.length - 1].lb };
  const wsOutcomeMs = Date.now() - t0;
  const historyResult = await history!;
  const positionAfter = await waitForPosition(slot, market, (p) => p.lotLNS !== positionBefore.lotLNS);
  const accountAfter = await chainAccount(slot);
  await sleep(1500); // let trailing frames land in the recording
  const frames = framesForRq(linesAfter(file, start), req.requestId);
  return {
    file,
    amount,
    fundTx,
    depositTx,
    accountBefore,
    accountAfterDeposit,
    positionBefore,
    positionAfter,
    accountAfter,
    request: req,
    attempts,
    lots,
    size6,
    mark18,
    outcome,
    wsOutcomeMs,
    history: historyResult,
    frames,
    events: orderEventsOf(frames, req.requestId),
  };
}

async function probeOpen() {
  const slot = await loadSlot(slotN);
  const market = await loadMarket("ETH");
  const usd = Number(flag("usd", "20"));
  const lev = Number(flag("lev", "2"));
  if (usd > 50 || lev > 3) throw new Error("Spec 03: tiny amounts only ($50, 3x max)");
  const r = await openLong(slot, market, usd, lev);
  closeAll();

  const depositCNS = r.positionAfter.depositCNS;
  const balanceDrop = r.accountAfterDeposit.balanceCNS - r.accountAfter.balanceCNS;
  const allLines = linesAfter(r.file, 0);
  const attemptsText = r.attempts
    .map((a) => {
      const f = framesForRq(allLines, a.rq);
      return `rq ${a.rq} (lb ${a.lb}): ${a.result}${a.error ? ` after ${a.error.split(":")[0]}` : ""}, lookups ${a.lookups}, frames ${cite(r.file, f.map((x) => x.line))}`;
    })
    .join(" ‖ ");
  const statusSeq = r.events.map((e) => `st${e.st}${e.sr ? `/sr${e.sr}` : ""}${e.fs !== undefined ? ` fs=${e.fs}` : ""} (L${e.line})`);
  const data = { ...r, frames: r.frames.map((f) => ({ line: f.line, dir: f.dir, mt: f.frame.mt })) };
  const rows: Row[] = [
    {
      verify: "tradingWs.ts:63",
      question: "IOC status sequence for one rq (does it always end Filled/Canceled/Expired? Open/PartiallyFilled first?)",
      answer: `rq ${r.request.requestId}: ${statusSeq.join(" → ") || "no mt:24 seen"}; outcome=${r.outcome.status}, filled ${r.outcome.filledSize6} size6 of ${r.size6} @ ${r.outcome.avgPrice18}`,
      evidence: cite(r.file, r.frames.map((f) => f.line)),
    },
    {
      verify: "adapter.ts:216 / findOrderOutcome",
      question: "Attempts (an expired IOC is looked up, then retried with a new rq)",
      answer: attemptsText,
      evidence: "order-history lookups in rest-*.jsonl",
    },
    {
      verify: "adapter.ts:216",
      question: "Latency until order-history shows the rq (250 ms polling)",
      answer: r.history.found
        ? `${r.history.latencyMs} ms after send (WS outcome at ${r.wsOutcomeMs} ms; ${r.history.polls} polls); history statuses: ${r.history.entries.map((o) => `st${o.st}`).join(", ")}`
        : `not seen within 60 s (${r.history.polls} polls)`,
      evidence: "GET /v1/trading/order-history (rest-*.jsonl)",
    },
    {
      verify: "adapter.ts:98 (2/2)",
      question: "Do position deposits leave balanceCNS?",
      answer: `balanceCNS ${r.accountBefore.balanceCNS} → ${r.accountAfterDeposit.balanceCNS} (after deposit) → ${r.accountAfter.balanceCNS} (after fill): dropped ${balanceDrop}; position depositCNS=${depositCNS}, pnlCNS=${r.positionAfter.pnlCNS}, premiumPnlCNS=${r.positionAfter.premiumPnlCNS}; lockedBalanceCNS=${r.accountAfter.lockedBalanceCNS}`,
      evidence: `deposit ${TX(r.depositTx)}; eth_call getAccountByAddr / getPosition before & after`,
    },
  ];
  appendFindings(`open --slot ${slotN} --usd ${usd} --lev ${lev}`, rows, data);
  return { rows, data };
}

/// Long liquidation price `P` where deposit + size*(P - entry) = m * size * P, under the two
/// readings of `maintenance_margin`: A = a fraction of notional (1e4), B = a fraction of the
/// initial margin (init x maint / 1e8). Only for comparing with the Perpl UI.
function liquidationPrices(market: ResolvedMarket & { maintenanceRaw?: number }, p: Awaited<ReturnType<typeof chainPosition>>) {
  if (p.lotLNS === 0n || p.positionType !== 0) return null;
  const size6 = lotsToSize6(p.lotLNS, market.sizeDecimals);
  const entry18 = pnsToPrice18(p.pricePNS, market.priceDecimals);
  const notionalAtEntry6 = (size6 * entry18) / 10n ** 18n;
  const init = Number(market.initialMarginFraction);
  const maintA = Number(process.env.PROBE_MAINT_RAW ?? 2000) / 1e4;
  const maintB = init * maintA;
  const liq = (m: number) => (Number(notionalAtEntry6) - Number(p.depositCNS)) / (Number(size6) * (1 - m));
  // C: maintenance_margin is a max leverage in hundredths (2000 = 20x = 5%) -- what the
  // leverage-clamp experiment supports for initial_margin.
  const maintC = 100 / Number(process.env.PROBE_MAINT_RAW ?? 2000);
  return { maintA, liqA: liq(maintA), maintB, liqB: liq(maintB), maintC, liqC: liq(maintC) };
}

async function probeEquity() {
  const slot = await loadSlot(slotN);
  const market = await loadMarket("ETH");
  const samples = Number(flag("samples", "3"));
  const intervalS = Number(flag("interval-s", "300"));
  const scale = await collateralScale();
  const out: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let i = 0; i < samples; i += 1) {
    if (i > 0) await sleep(intervalS * 1000);
    const p = await chainPosition(slot, market);
    const positions = await getPositions(credentialsFor(slot));
    const apiPos = (positions.d ?? []).find((x) => x.mkt === market.venueMarketId && x.st === 1);
    const mark18 = pnsToPrice18(p.markPricePNS, market.priceDecimals);
    const entry18 = pnsToPrice18(p.pricePNS, market.priceDecimals);
    const size6 = lotsToSize6(p.lotLNS, market.sizeDecimals);
    const sign = p.positionType === 0 ? 1n : -1n;
    // Price PnL at the mark, in asset units (size6 x price18 / 1e18 -> 6 dp).
    const pricePnl = (sign * size6 * (mark18 - entry18)) / 10n ** 18n;
    const apiC = apiPos?.c;
    const apiEntry18 = apiPos?.ep ? pnsToPrice18(apiPos.ep, market.priceDecimals) : 0n;
    const apiSize6 = apiPos?.s ? lotsToSize6(apiPos.s, market.sizeDecimals) : 0n;
    const apiUnrealized = (sign * apiSize6 * (mark18 - apiEntry18)) / 10n ** 18n;
    const apiCAsset = apiC !== undefined ? cnsToAsset(BigInt(String(apiC).split(".")[0]), scale) : null;
    out.push({
      at: new Date().toISOString(),
      chain: {
        depositCNS: p.depositCNS,
        pnlCNS: p.pnlCNS,
        deltaPnlCNS: p.deltaPnlCNS,
        premiumPnlCNS: p.premiumPnlCNS,
        lotLNS: p.lotLNS,
        pricePNS: p.pricePNS,
        markPNS: p.markPricePNS,
        markValid: p.markPriceValid,
      },
      derived: {
        pricePnlAtMark6: pricePnl,
        depositPlusPnl: p.depositCNS + p.pnlCNS,
        depositPlusPnlPlusPremium: p.depositCNS + p.pnlCNS + p.premiumPnlCNS,
        depositPlusPricePnl: p.depositCNS + pricePnl,
        positionValue6: (size6 * mark18) / 10n ** 18n,
      },
      api: apiPos ? { c: apiC, ep: apiPos.ep, s: apiPos.s, lv: apiPos.lv, fee: apiPos.fee, xp: apiPos.xp, unrealizedAtMark6: apiUnrealized, cPlusUnrealized6: apiCAsset === null ? null : apiCAsset + apiUnrealized, raw: redact(apiPos) } : null,
      liquidationHypotheses: liquidationPrices(market, p),
    });
    console.log(json(out[out.length - 1]));
  }
  const fmt = (s: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
   
    `${s.at.slice(11, 19)}: deposit+pnl=${s.derived.depositPlusPnl}, +premium=${s.derived.depositPlusPnlPlusPremium}, deposit+pricePnl@mark=${s.derived.depositPlusPricePnl}, pnlCNS=${s.chain.pnlCNS} vs pricePnl@mark=${s.derived.pricePnlAtMark6}, premium=${s.chain.premiumPnlCNS}; API c+uPnL=${s.api?.cPlusUnrealized6 ?? "n/a"}; value=${s.derived.positionValue6}`;
  const rows: Row[] = [
    {
      verify: "adapter.ts:277",
      question: "Does pnlCNS include premiumPnlCNS? Which sum matches API `c` + unrealized (and the Perpl UI)?",
      answer: out.map(fmt).join(" ‖ ") + " ‖ Perpl UI: (fill in)",
      evidence: "eth_call getPosition; GET /v1/trading/positions (rest-*.jsonl)",
    },
  ];
  appendFindings(`equity --slot ${slotN}`, rows, out);
  return { rows, data: out };
}

async function probeAddMargin() {
  const slot = await loadSlot(slotN);
  const market = await loadMarket("ETH");
  const usd = Number(flag("usd", "5"));
  const decimals = await assetDecimals();
  const scale = await collateralScale();
  const amount = BigInt(Math.round(usd * 10 ** decimals));
  const fundTx = await fundSlotWallet(slot, amount);
  const depositTx = await venue().deposit(slot, amount);
  const file = recordingFile(slot);
  const attempts = [];

  for (const form of ["cns-integer", "human-decimal"] as const) {
    const before = await chainPosition(slot, market);
    const accBefore = await chainAccount(slot);
    const start = lineCount(file);
    const req = await nextRequest(slot, market);
    const cns = amount * 10n ** BigInt(scale.cnsDecimals) / 10n ** BigInt(decimals);
    const a = form === "cns-integer" ? cns.toString() : String(usd);
    let raw: unknown;
    let error: string | undefined;
    try {
      raw = await ensure(slot).sendOrder(
        {
          rq: Number(req.requestId),
          mkt: market.venueMarketId,
          acc: Number(slot.perplAccountId),
          t: OrderType.IncreasePositionCollateral,
          p: 0,
          s: 0,
          a,
          fl: OrderFlags.GoodTillCancel,
          lv: 0,
          lb: Number(req.lastExecBlock),
        },
        "instant",
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const after = await waitForPosition(slot, market, (p) => p.depositCNS !== before.depositCNS);
    const accAfter = await chainAccount(slot);
    await sleep(1500);
    const frames = framesForRq(linesAfter(file, start), req.requestId);
    const moved = after.depositCNS - before.depositCNS;
    attempts.push({
      form,
      a,
      rq: req.requestId,
      raw,
      error,
      depositCNSBefore: before.depositCNS,
      depositCNSAfter: after.depositCNS,
      moved,
      balanceCNSBefore: accBefore.balanceCNS,
      balanceCNSAfter: accAfter.balanceCNS,
      statuses: orderEventsOf(frames, req.requestId).map((e) => ({ st: e.st, sr: e.sr, fr: e.fr, line: e.line })),
      ack: frames.filter((f) => f.frame.mt === 3).map((f) => ({ line: f.line, status: f.frame.status })),
      evidence: cite(file, frames.map((f) => f.line)),
    });
    if (moved === cns) break;
  }
  closeAll();
  const hit = attempts.find((x) => x.moved > 0n);
  const rows: Row[] = [
    {
      verify: "adapter.ts:185",
      question: "Unit of `a` on a t:6 order",
      answer: hit
        ? `${hit.form} ("${hit.a}") moved depositCNS by ${hit.moved}` +
          (attempts.length > 1 ? `; ${attempts[0].form} ("${attempts[0].a}") moved ${attempts[0].moved}` : "")
        : `neither form moved depositCNS (${attempts.map((x) => `${x.form}: ${x.error ?? "no move"}`).join("; ")})`,
      evidence: attempts.map((x) => `${x.form}: ${x.evidence}`).join("; ") + `; deposit ${TX(depositTx)}`,
    },
    {
      verify: "adapter.ts:334",
      question: "Which statuses Perpl reports for a t:6 order",
      answer: attempts
        .map((x) => `${x.form}: ack ${x.ack.map((k) => json(k.status).replace(/\s+/g, "")).join(",") || "none"}; mt:24 ${x.statuses.map((s) => `st${s.st}${s.sr ? `/sr${s.sr}` : ""}${s.fr ? `/fr${s.fr}` : ""}`).join(" → ") || "none"}`)
        .join(" ‖ "),
      evidence: attempts.map((x) => x.evidence).join("; "),
    },
  ];
  appendFindings(`add-margin --slot ${slotN} --usd ${usd}`, rows, { fundTx, depositTx, attempts });
  return { rows, data: attempts };
}

async function probeIncrease() {
  const slot = await loadSlot(slotN);
  const market = await loadMarket("ETH");
  const usd = Number(flag("usd", "10"));
  const lev = Number(flag("lev", "2"));
  if (usd > 50 || lev > 3) throw new Error("Spec 03: tiny amounts only ($50, 3x max)");
  const r = await openLong(slot, market, usd, lev);
  closeAll();
  const before = r.positionBefore;
  const after = r.positionAfter;
  const rows: Row[] = [
    {
      verify: "Spec 01 Phase B",
      question: "Does adding size reset premiumPnlCNS to 0?",
      answer: `premiumPnlCNS ${before.premiumPnlCNS} → ${after.premiumPnlCNS}; pnlCNS ${before.pnlCNS} → ${after.pnlCNS}; depositCNS ${before.depositCNS} → ${after.depositCNS}; lots ${before.lotLNS} → ${after.lotLNS}; entry ${before.pricePNS} → ${after.pricePNS}; order ${r.outcome.status}`,
      evidence: `${cite(r.file, r.frames.map((f) => f.line))}; deposit ${TX(r.depositTx)}`,
    },
  ];
  appendFindings(`increase --slot ${slotN} --usd ${usd}`, rows, { ...r, frames: r.frames.map((f) => ({ line: f.line, mt: f.frame.mt })) });
  return { rows, data: r };
}

async function probeClose() {
  const slot = await loadSlot(slotN);
  const market = await loadMarket("ETH");
  const decimals = await assetDecimals();
  const scale = await collateralScale();
  const before = await chainPosition(slot, market);
  const file = recordingFile(slot);
  let closeResult: Record<string, unknown> = { skipped: "no open position" };
  if (before.lotLNS > 0n) {
    const start = lineCount(file);
    const { outcome, attempts } = await placeWithRecovery(slot, market, {
      side: before.positionType === 0 ? "close_long" : "close_short",
      size6: lotsToSize6(before.lotLNS, market.sizeDecimals),
      leverage: 1,
    });
    const req = { requestId: attempts[attempts.length - 1].rq };
    const after = await waitForPosition(slot, market, (p) => p.lotLNS === 0n);
    await sleep(1500);
    const frames = framesForRq(linesAfter(file, start), req.requestId);
    closeResult = {
      rq: req.requestId,
      attempts,
      outcome,
      positionAfter: after,
      statuses: orderEventsOf(frames, req.requestId).map((e) => `st${e.st}${e.sr ? `/sr${e.sr}` : ""} fs=${e.fs ?? 0} (L${e.line})`),
      evidence: cite(file, frames.map((f) => f.line)),
    };
  }

  const account = await chainAccount(slot);
  const reserveAsset = BigInt(slot.reserve);
  const balanceAsset = cnsToAsset(account.balanceCNS, scale);
  const noWithdraw = rest.includes("--no-withdraw");
  const withdrawAsset = !noWithdraw && balanceAsset > reserveAsset ? balanceAsset - reserveAsset : 0n;
  const blockBefore = await publicClient().getBlockNumber();
  const allowanceBefore = await getWithdrawAllowanceData(blockBefore);
  let withdrawTx: string | undefined;
  let withdrawError: string | undefined;
  if (withdrawAsset > 0n) {
    try {
      withdrawTx = await venue().withdraw(slot, withdrawAsset);
    } catch (e) {
      withdrawError = e instanceof Error ? e.message.split("\n")[0] : String(e);
    }
  }
  const blockAfter = await publicClient().getBlockNumber();
  const allowanceAfter = await getWithdrawAllowanceData(blockAfter);
  const accountAfter = await chainAccount(slot);

  // Tidy: the withdrawn money goes back to the float.
  const walletBalance = await assetBalanceOf(slot.operatorWallet.address as Address);
  const sweepTx = !noWithdraw && walletBalance > 0n ? await transferAsset(slotWallet(slot), floatAddress(), walletBalance) : undefined;
  closeAll();

  const data = {
    close: closeResult,
    balanceCNSAfterClose: account.balanceCNS,
    reserveAsset,
    withdrawAsset,
    withdrawTx,
    withdrawError,
    allowanceBefore: { block: blockBefore, ...allowanceBefore },
    allowanceAfter: { block: blockAfter, ...allowanceAfter },
    balanceCNSAfterWithdraw: accountAfter.balanceCNS,
    sweepTx,
    sweptAsset: walletBalance,
    decimals,
  };
  const rows: Row[] = [
    {
      verify: "close",
      question: "IOC close: statuses, final balance",
      answer: `${(closeResult.statuses as string[] | undefined)?.join(" → ") ?? closeResult.skipped}; outcome ${(closeResult.outcome as { status?: string } | undefined)?.status ?? "-"}; balanceCNS after close ${account.balanceCNS}`,
      evidence: (closeResult.evidence as string | undefined) ?? "-",
    },
    {
      verify: "withdraw",
      question: "Withdraw everything above the reserve; getWithdrawAllowanceData before/after",
      answer: `withdrew ${withdrawAsset} asset units ${withdrawError ? `**failed: ${withdrawError}**` : "ok"}; balanceCNS → ${accountAfter.balanceCNS} (reserve ${reserveAsset}); allowanceCNS ${allowanceBefore.allowanceCNS} → ${allowanceAfter.allowanceCNS}, cnsPerBlock ${allowanceBefore.cnsPerBlock}, expiry ${allowanceBefore.expiryBlock} → ${allowanceAfter.expiryBlock}`,
      evidence: [withdrawTx && `withdraw ${TX(withdrawTx)}`, sweepTx && `sweep ${TX(sweepTx)}`].filter(Boolean).join("; ") || "-",
    },
  ];
  if (noWithdraw) rows.pop();
  appendFindings(`close --slot ${slotN}${noWithdraw ? " --no-withdraw" : ""}`, rows, data);
  return { rows, data };
}

// --- Main ------------------------------------------------------------------------------

const COMMANDS: Record<string, () => Promise<{ rows: Row[]; data: unknown }>> = {
  context: probeContext,
  markets: probeMarkets,
  slot: probeSlot,
  heartbeat: probeHeartbeat,
  open: probeOpen,
  equity: probeEquity,
  "add-margin": probeAddMargin,
  increase: probeIncrease,
  close: probeClose,
};

async function main(): Promise<void> {
  const run = COMMANDS[command ?? ""];
  if (!run) {
    console.error(`usage: npm run probe -- <${Object.keys(COMMANDS).join("|")}> [--slot n] [--usd x] [--lev x]`);
    process.exit(2);
  }
  const result = await run();
  console.log(json(result));
}

main()
  .then(async () => {
    closeAll();
    await db.$disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    closeAll();
    await db.$disconnect();
    process.exit(1);
  });
