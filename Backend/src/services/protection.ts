import type { ProtectionEvent, ProtectionRule } from "@prisma/client";
import { encodeFunctionData, getAddress, isAddress, parseEventLogs, type Address, type Log } from "viem";

import { isEmbeddedWalletOf, privy } from "../auth/privy";
import { erc20Abi, lendingPoolAbi } from "../chain/abi";
import { assetDecimals, publicClient, withWalletLock } from "../chain/clients";
import { debtAssetFor, gasWithBuffer, healthFactorFor, receiptStatus } from "../chain/writes";
import { db } from "../config/db";
import { config, protectionConfigProblems } from "../config/env";
import { startWorker } from "../lib/async";
import { HttpError, badRequest, conflict, notFound, serviceUnavailable } from "../lib/errors";
import { createLogger, errorFields } from "../lib/logger";
import { createRepayPolicy } from "../privy/policies";
import { classifyPrivyError, describePrivyError, privyWalletSender } from "../privy/signer";
import { UINT256_MAX, formatHealth, healthToWad } from "./protectionMath";
import {
  ProtectionInputError,
  baseToHuman,
  decide,
  pendingState,
  shouldRecordSkip,
  skipNote,
  validateRuleInput,
  type Decision,
  type Detail,
  type Reader,
  type RuleView,
} from "./protectionRules";

const log = createLogger("protection");

/**
 * Loan protection (Spec 05 Part 2): when a user's health factor on a lending pool
 * falls to their trigger, repay enough from THEIR OWN Privy embedded wallet to
 * bring it back to their target.
 *
 * Two safety layers, both set by the user: a Privy policy limits WHAT the server
 * may call (`repay` on this pool, up to maxPerCall, no value), and the ERC-20
 * allowance limits HOW MUCH it can ever spend. See docs/privy-integration.md.
 */

const ASSET_SYMBOL = "AUSD";
/// A PENDING marker older than this belongs to a dead process and is settled from the chain.
const PENDING_STALE_MS = 10 * 60_000;
const RECEIPT_TIMEOUT_MS = 90_000;
const EVENTS_SHOWN = 20;

/// One tick at a time per rule, in this process (workers run in one process by design).
const inFlight = new Set<string>();

// ---------------------------------------------------------------------------
// Chain reads (all through the shared paced transport)
// ---------------------------------------------------------------------------

const debtAssets = new Map<string, Address>();
const thresholds = new Map<string, bigint>();

async function poolDebtAsset(pool: Address): Promise<Address> {
  const key = pool.toLowerCase();
  let asset = debtAssets.get(key);
  if (!asset) {
    asset = await debtAssetFor(pool);
    debtAssets.set(key, asset);
  }
  return asset;
}

async function poolThresholdBps(pool: Address): Promise<bigint> {
  const key = pool.toLowerCase();
  let bps = thresholds.get(key);
  if (bps === undefined) {
    bps = (await publicClient().readContract({ address: pool, abi: lendingPoolAbi, functionName: "liquidationThresholdBps" })) as bigint;
    thresholds.set(key, bps);
  }
  return bps;
}

const readPool = <T>(pool: Address, functionName: string, wallet: Address) =>
  publicClient().readContract({ address: pool, abi: lendingPoolAbi, functionName, args: [wallet] } as never) as Promise<T>;

async function assetBalance(asset: Address, wallet: Address): Promise<bigint> {
  return (await publicClient().readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [wallet] })) as bigint;
}

async function assetAllowance(asset: Address, wallet: Address, spender: Address): Promise<bigint> {
  return (await publicClient().readContract({ address: asset, abi: erc20Abi, functionName: "allowance", args: [wallet, spender] })) as bigint;
}

function chainReader(pool: Address, wallet: Address): Reader {
  return {
    async basics() {
      const [health, debt] = await Promise.all([healthFactorFor(pool, wallet), readPool<bigint>(pool, "currentDebt", wallet)]);
      return { debt, health };
    },
    async detail(): Promise<Detail> {
      const asset = await poolDebtAsset(pool);
      const [collateralValue, thresholdBps, balance, allowance] = await Promise.all([
        readPool<bigint>(pool, "collateralValue", wallet),
        poolThresholdBps(pool),
        assetBalance(asset, wallet),
        assetAllowance(asset, wallet, pool),
      ]);
      return { collateralValue, thresholdBps, balance, allowance };
    },
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const latestEvent = (ruleId: string) => db.protectionEvent.findFirst({ where: { ruleId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });

async function disableRule(rule: ProtectionRule, note: string): Promise<void> {
  await db.$transaction([
    db.protectionRule.update({ where: { id: rule.id }, data: { enabled: false, lastNote: note } }),
    db.protectionEvent.create({ data: { ruleId: rule.id, kind: "DISABLED", note } }),
  ]);
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export async function runProtectionTick(): Promise<void> {
  const rules = await db.protectionRule.findMany({ where: { enabled: true } });
  for (const rule of rules) {
    try {
      await runRule(rule);
    } catch (error) {
      log.error("protection check failed", { ruleId: rule.id, ...errorFields(error) });
    }
  }
}

export function startProtectionJob(): () => void {
  log.info("loan protection starting", { intervalMs: config.protectionIntervalMs, cooldownS: config.protectionCooldownS });
  return startWorker("protection", config.protectionIntervalMs, runProtectionTick, (error) =>
    log.error("protection tick threw", errorFields(error)),
  );
}

export async function runRule(rule: ProtectionRule, now = Date.now()): Promise<Decision | "busy"> {
  if (inFlight.has(rule.id)) return "busy";
  inFlight.add(rule.id);
  try {
    return await runRuleLocked(rule, now);
  } finally {
    inFlight.delete(rule.id);
  }
}

async function runRuleLocked(rule: ProtectionRule, now: number): Promise<Decision | "busy"> {
  const last = await latestEvent(rule.id);
  if (last?.kind === "PENDING") {
    if (pendingState(last.createdAt.getTime(), now, PENDING_STALE_MS) === "in-flight") return "busy";
    await settleStalePending(rule, last);
    return "busy";
  }

  const user = await db.user.findUnique({ where: { privyUserId: rule.privyUserId } });
  const view: RuleView = {
    enabled: rule.enabled,
    signerVerified: rule.signerVerifiedAt !== null && rule.privyWalletId !== null && rule.privyPolicyId !== null,
    walletMatchesUser: user?.walletAddress.toLowerCase() === rule.walletAddress,
    triggerWad: healthToWad(rule.triggerHealth),
    targetWad: healthToWad(rule.targetHealth),
    maxSpend: BigInt(rule.maxSpend),
    maxPerCall: BigInt(rule.maxPerCall),
    spent: BigInt(rule.spent),
    lastActionAtMs: rule.lastActionAt?.getTime() ?? null,
  };

  const pool = rule.poolAddress as Address;
  const wallet = rule.walletAddress as Address;
  const decision = await decide(view, chainReader(pool, wallet), now, config.protectionCooldownS);
  const decimals = await assetDecimals();

  switch (decision.kind) {
    case "idle":
      if (decision.why === "wallet-mismatch") {
        // Rule 7: the user's resolved wallet is no longer the rule's wallet. Never act; switch off.
        await disableRule(rule, "Protection turned itself off: your Laxu wallet changed.");
        log.warn("rule disabled: wallet no longer matches the user", { ruleId: rule.id });
      }
      break;

    case "no-debt": {
      const note = "No debt on this loan, nothing to protect.";
      if (shouldRecordSkip(toLast(last), note, now, Number.POSITIVE_INFINITY)) {
        await db.protectionEvent.create({ data: { ruleId: rule.id, kind: "SKIPPED", note } });
      }
      await touch(rule, now, null);
      break;
    }

    case "healthy":
      // Healthy again: a stale "could not act" banner no longer applies.
      await touch(rule, now, null);
      log.debug("checked", { ruleId: rule.id, health: formatHealth(decision.health) });
      break;

    case "cooldown":
      await touch(rule, now, undefined);
      log.debug("cooldown", { ruleId: rule.id, retryInS: decision.retryInS });
      break;

    case "skip": {
      const note = skipNote(decision.reason, ASSET_SYMBOL, view.maxSpend, decimals);
      if (shouldRecordSkip(toLast(last), note, now, config.protectionCooldownS)) {
        await db.protectionEvent.create({
          data: { ruleId: rule.id, kind: "SKIPPED", note, healthBefore: formatHealth(decision.health) },
        });
        log.info("could not act", { ruleId: rule.id, reason: decision.reason });
      }
      await touch(rule, now, note);
      break;
    }

    case "repay":
      await touch(rule, now, undefined);
      await executeRepay(rule, decision.amount, decision.health, now);
      break;
  }
  return decision;
}

const toLast = (event: ProtectionEvent | null) =>
  event ? { kind: event.kind, note: event.note, createdAtMs: event.createdAt.getTime() } : null;

/// Records that the rule was just checked. `note`: a string sets the banner, null clears it, undefined leaves it.
async function touch(rule: ProtectionRule, now: number, note: string | null | undefined): Promise<void> {
  await db.protectionRule.update({
    where: { id: rule.id },
    data: { lastCheckedAt: new Date(now), ...(note !== undefined ? { lastNote: note } : {}) },
  });
}

function repaidFromLogs(logs: Log[], pool: Address, wallet: Address): bigint | null {
  const found = parseEventLogs({ abi: lendingPoolAbi, logs, eventName: "Repaid" }).find(
    (entry) => entry.address.toLowerCase() === pool.toLowerCase() && entry.args.user.toLowerCase() === wallet.toLowerCase(),
  );
  return found ? found.args.principal + found.args.interest : null;
}

async function executeRepay(rule: ProtectionRule, amount: bigint, healthBefore: bigint, now: number): Promise<void> {
  const pool = rule.poolAddress as Address;
  const wallet = rule.walletAddress as Address;
  const walletId = rule.privyWalletId as string;

  // The marker first: a crash after this leaves a PENDING row that blocks the rule until it is settled.
  const pending = await db.protectionEvent.create({
    data: { ruleId: rule.id, kind: "PENDING", amount: amount.toString(), healthBefore: formatHealth(healthBefore) },
  });
  // The cooldown starts at the attempt, whatever its outcome.
  await db.protectionRule.update({ where: { id: rule.id }, data: { lastActionAt: new Date(now) } });

  try {
    const call = { address: pool, abi: lendingPoolAbi, functionName: "repay", args: [amount] } as const;
    const data = encodeFunctionData({ abi: lendingPoolAbi, functionName: "repay", args: [amount] });
    // Our own estimate plus the shared buffer: Monad bills the gas LIMIT, so no large constant. A call that
    // would revert (allowance or balance moved since the read) fails here, before any gas is spent.
    const gas = await gasWithBuffer({ ...call, account: wallet });

    const { hash } = await withWalletLock(wallet, () =>
      privyWalletSender().sendTx(walletId, { to: pool, data, value: 0n, gas, chainId: config.chainId }),
    );
    await db.protectionEvent.update({ where: { id: pending.id }, data: { txHash: hash } });

    const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== "success") throw new Error(`repay reverted (tx ${hash})`);

    // What the pool actually took, not what we asked for (it trims to the outstanding debt).
    const repaid = repaidFromLogs(receipt.logs as Log[], pool, wallet);
    const healthAfter = await healthFactorFor(pool, wallet);
    const spent = BigInt(rule.spent) + (repaid ?? amount);

    await db.$transaction([
      db.protectionRule.update({ where: { id: rule.id }, data: { spent: spent.toString(), lastNote: null } }),
      db.protectionEvent.update({
        where: { id: pending.id },
        data: {
          kind: "REPAID",
          amount: (repaid ?? amount).toString(),
          healthAfter: formatHealth(healthAfter),
          txHash: hash,
          note: repaid === null ? "Repaid event not found in the receipt; amount is the requested one." : `requested ${amount}`,
        },
      }),
    ]);
    log.info("repaid", {
      ruleId: rule.id,
      pool,
      wallet,
      repaid: (repaid ?? amount).toString(),
      healthBefore: formatHealth(healthBefore),
      healthAfter: formatHealth(healthAfter),
      txHash: hash,
    });
  } catch (error) {
    await recordFailure(rule, pending.id, error);
  }
}

async function recordFailure(rule: ProtectionRule, eventId: string, error: unknown): Promise<void> {
  const kind = classifyPrivyError(error);
  const text = describePrivyError(error);
  await db.protectionEvent.update({ where: { id: eventId }, data: { kind: "FAILED", note: text } });
  log.error("repay failed", { ruleId: rule.id, kind, message: text });

  if (kind === "signer-removed") {
    // Privy answers 401 once the user has removed the signer: acting is impossible, so stop trying.
    await disableRule(rule, "Protection turned itself off: Laxu's signer is no longer on your wallet.");
    return;
  }
  await db.protectionRule.update({
    where: { id: rule.id },
    data: { lastNote: "The last repay attempt failed. It will try again after a short wait." },
  });
}

/// A PENDING marker from a process that died: settle it from the chain, never by guessing.
async function settleStalePending(rule: ProtectionRule, event: ProtectionEvent): Promise<void> {
  const pool = rule.poolAddress as Address;
  const wallet = rule.walletAddress as Address;

  if (!event.txHash) {
    await db.protectionEvent.update({ where: { id: event.id }, data: { kind: "FAILED", note: "Interrupted before the repay was sent (backend restarted)." } });
    return;
  }
  const status = await receiptStatus(event.txHash as `0x${string}`);
  if (status === "success") {
    const receipt = await publicClient().getTransactionReceipt({ hash: event.txHash as `0x${string}` });
    const repaid = repaidFromLogs(receipt.logs as Log[], pool, wallet) ?? BigInt(event.amount ?? "0");
    const healthAfter = await healthFactorFor(pool, wallet);
    await db.$transaction([
      db.protectionRule.update({ where: { id: rule.id }, data: { spent: (BigInt(rule.spent) + repaid).toString(), lastNote: null } }),
      db.protectionEvent.update({
        where: { id: event.id },
        data: { kind: "REPAID", amount: repaid.toString(), healthAfter: formatHealth(healthAfter), note: "Settled after a restart." },
      }),
    ]);
    return;
  }
  await db.protectionEvent.update({
    where: { id: event.id },
    data: { kind: "FAILED", note: status === "reverted" ? "The repay reverted on chain." : `Could not confirm the repay (tx ${event.txHash}); check the explorer.` },
  });
}

// ---------------------------------------------------------------------------
// Routes' business logic
// ---------------------------------------------------------------------------

export interface Caller {
  privyUserId: string;
  /// users.walletAddress, lowercase: from the authenticated user row, never a request body.
  walletAddress: string;
}

function requireConfigured(): void {
  const problems = protectionConfigProblems();
  if (problems.length > 0) throw serviceUnavailable("Loan protection is not set up on this server.", "PROTECTION_UNAVAILABLE");
}

async function ownedRule(caller: Caller, id: string): Promise<ProtectionRule> {
  const rule = await db.protectionRule.findUnique({ where: { id } });
  // Same answer for "no such rule" and "somebody else's", so ids reveal nothing.
  if (!rule || rule.privyUserId !== caller.privyUserId || rule.walletAddress !== caller.walletAddress) throw notFound("No such protection rule");
  return rule;
}

async function privyWalletOf(address: string) {
  return privy().wallets().getWalletByAddress({ address });
}

export interface CreateInput {
  pool: string;
  triggerHealth: string;
  targetHealth: string;
  maxSpend: string;
}

export async function createRule(caller: Caller, input: CreateInput) {
  requireConfigured();
  const decimals = await assetDecimals();

  let valid;
  try {
    valid = validateRuleInput(input, decimals, BigInt(config.protectionMaxSpendCap));
  } catch (error) {
    if (error instanceof ProtectionInputError) throw badRequest(error.message, error.code);
    throw error;
  }

  if (!isAddress(input.pool)) throw badRequest("pool must be an address", "INVALID_POOL");
  const poolAddress = getAddress(input.pool).toLowerCase();
  const pool = await db.lendingPool.findUnique({ where: { poolAddress } });
  if (!pool) throw badRequest("That is not a Laxu lending pool", "UNKNOWN_POOL");

  // Signers attach to Privy embedded wallets only (Spec 05 2.0b).
  if (!(await isEmbeddedWalletOf(caller.privyUserId, caller.walletAddress))) {
    throw new HttpError(409, "Loan protection needs a Laxu wallet created with email sign-in.", "NOT_EMBEDDED_WALLET");
  }

  const wallet = caller.walletAddress as Address;
  const [debt, collateral] = await Promise.all([
    readPool<bigint>(poolAddress as Address, "currentDebt", wallet),
    readPool<bigint>(poolAddress as Address, "collateralBalance", wallet),
  ]);
  if (debt === 0n && collateral === 0n) throw badRequest("You have no loan on this pool.", "NO_LOAN");

  // A signer carries at most one policy, so a wallet can have one active rule: adding the signer for a
  // second pool would replace the first pool's policy and silently break it.
  const other = await db.protectionRule.findFirst({
    where: { walletAddress: caller.walletAddress, enabled: true, NOT: { poolAddress } },
  });
  if (other) throw conflict("Protection is already on for another of your loans. Turn it off before protecting this one.", "ANOTHER_RULE_ACTIVE");
  const existing = await db.protectionRule.findUnique({ where: { walletAddress_poolAddress: { walletAddress: caller.walletAddress, poolAddress } } });
  if (existing?.enabled) throw conflict("Protection is already on for this loan.", "RULE_EXISTS");

  const privyWallet = await privyWalletOf(caller.walletAddress);
  const policyId = await createRepayPolicy({ pool: poolAddress, maxPerCall: valid.maxPerCall, chainId: config.chainId });

  const data = {
    privyUserId: caller.privyUserId,
    walletAddress: caller.walletAddress,
    poolAddress,
    positionToken: pool.positionTokenAddress,
    triggerHealth: valid.triggerHealth,
    targetHealth: valid.targetHealth,
    maxSpend: valid.maxSpend.toString(),
    maxPerCall: valid.maxPerCall.toString(),
    // A re-created rule starts from a clean slate: the old allowance was set to 0 when it was turned off.
    spent: "0",
    privyPolicyId: policyId,
    privyWalletId: privyWallet.id,
    enabled: false,
    signerVerifiedAt: null,
    lastNote: null,
  };
  const rule = existing
    ? await db.protectionRule.update({ where: { id: existing.id }, data })
    : await db.protectionRule.create({ data });

  const debtAsset = await poolDebtAsset(poolAddress as Address);
  return {
    ruleId: rule.id,
    policyId,
    signerConfig: { address: caller.walletAddress, signers: [{ signerId: config.privySignerId, policyIds: [policyId] }] },
    allowanceToApprove: {
      token: debtAsset,
      spender: poolAddress,
      amount: valid.maxSpend.toString(),
      amountHuman: baseToHuman(valid.maxSpend, decimals),
    },
    maxPerCall: valid.maxPerCall.toString(),
  };
}

/// Called after the frontend finished both user approvals. The backend checks both itself.
export async function activateRule(caller: Caller, id: string) {
  requireConfigured();
  const rule = await ownedRule(caller, id);
  if (rule.enabled) return serialise(rule, []);
  if (!rule.privyPolicyId) throw conflict("This rule has no policy; set it up again.", "NO_POLICY");

  if (!(await isEmbeddedWalletOf(caller.privyUserId, rule.walletAddress))) {
    throw new HttpError(409, "Loan protection needs a Laxu wallet created with email sign-in.", "NOT_EMBEDDED_WALLET");
  }
  const other = await db.protectionRule.findFirst({ where: { walletAddress: rule.walletAddress, enabled: true, NOT: { id: rule.id } } });
  if (other) throw conflict("Protection is already on for another of your loans.", "ANOTHER_RULE_ACTIVE");

  // (a) Ask Privy, do not trust the client: our signer, restricted by exactly this rule's policy.
  const wallet = await privyWalletOf(rule.walletAddress);
  const signers = (wallet.additional_signers ?? []) as Array<{ signer_id: string; override_policy_ids?: string[] }>;
  const ours = signers.find((signer) => signer.signer_id === config.privySignerId);
  if (!ours) throw conflict("Laxu is not allowed to repay from your wallet yet. Finish step 1 (Allow Laxu to repay).", "SIGNER_MISSING");
  const policyIds = ours.override_policy_ids ?? [];
  if (policyIds.length !== 1 || policyIds[0] !== rule.privyPolicyId) {
    throw conflict("The permission on your wallet does not match this rule. Set protection up again.", "SIGNER_POLICY_MISMATCH");
  }

  // (b) The allowance, read on chain.
  const asset = await poolDebtAsset(rule.poolAddress as Address);
  const allowance = await assetAllowance(asset, rule.walletAddress as Address, rule.poolAddress as Address);
  if (allowance < BigInt(rule.maxSpend)) {
    throw conflict("The spending limit has not been approved yet. Finish step 2 (Approve spending limit).", "ALLOWANCE_TOO_LOW");
  }

  const now = new Date();
  const [updated] = await db.$transaction([
    db.protectionRule.update({
      where: { id: rule.id },
      data: { enabled: true, signerVerifiedAt: now, privyWalletId: wallet.id, lastNote: null, lastActionAt: null },
    }),
    db.protectionEvent.create({
      data: { ruleId: rule.id, kind: "ENABLED", note: `trigger ${rule.triggerHealth}, target ${rule.targetHealth}, max ${rule.maxSpend}` },
    }),
  ]);
  log.info("protection enabled", { ruleId: rule.id, pool: rule.poolAddress });
  return serialise(updated, []);
}

/// Stops the worker at once (the rule row is what it reads). Never depends on Privy being up.
export async function turnOffRule(caller: Caller, id: string) {
  const rule = await ownedRule(caller, id);
  if (!rule.enabled) return serialise(rule, []);

  // Best effort: what the wallet looks like right now, for the log. Failure here changes nothing.
  const state = await liveSignerAndAllowance(rule).catch(() => null);
  const note = state
    ? `Turned off by you. Signer still on wallet: ${state.signerPresent ?? "unknown"}; allowance: ${state.allowance ?? "unknown"}.`
    : "Turned off by you.";
  await disableRule(rule, note);
  log.info("protection disabled by user", { ruleId: rule.id });
  const fresh = await db.protectionRule.findUniqueOrThrow({ where: { id } });
  return serialise(fresh, []);
}

const signerCache = new Map<string, { at: number; present: boolean | null }>();

async function liveSignerAndAllowance(rule: ProtectionRule): Promise<{ signerPresent: boolean | null; allowance: string | null }> {
  const cached = signerCache.get(rule.id);
  let signerPresent: boolean | null;
  if (cached && Date.now() - cached.at < 15_000) {
    signerPresent = cached.present;
  } else {
    try {
      const wallet = await privyWalletOf(rule.walletAddress);
      const signers = (wallet.additional_signers ?? []) as Array<{ signer_id: string }>;
      signerPresent = signers.some((signer) => signer.signer_id === config.privySignerId);
    } catch {
      signerPresent = null;
    }
    signerCache.set(rule.id, { at: Date.now(), present: signerPresent });
  }
  let allowance: string | null = null;
  try {
    const asset = await poolDebtAsset(rule.poolAddress as Address);
    allowance = (await assetAllowance(asset, rule.walletAddress as Address, rule.poolAddress as Address)).toString();
  } catch {
    allowance = null;
  }
  return { signerPresent, allowance };
}

export async function listRules(caller: Caller) {
  const rules = await db.protectionRule.findMany({
    where: { privyUserId: caller.privyUserId, walletAddress: caller.walletAddress },
    orderBy: { createdAt: "desc" },
    include: { events: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: EVENTS_SHOWN } },
  });
  const decimals = await assetDecimals();
  return {
    assetDecimals: decimals,
    assetSymbol: ASSET_SYMBOL,
    rules: await Promise.all(rules.map(async (rule) => serialise(rule, rule.events, await liveView(rule)))),
  };
}

/// Live numbers for the card. Each read may fail on its own; a missing figure is null, not an error.
async function liveView(rule: ProtectionRule) {
  const pool = rule.poolAddress as Address;
  const wallet = rule.walletAddress as Address;
  const settle = async <T>(fn: () => Promise<T>): Promise<T | null> => fn().catch(() => null);

  const [health, debt, balance, signerState] = await Promise.all([
    settle(() => healthFactorFor(pool, wallet)),
    settle(() => readPool<bigint>(pool, "currentDebt", wallet)),
    settle(async () => assetBalance(await poolDebtAsset(pool), wallet)),
    settle(() => liveSignerAndAllowance(rule)),
  ]);
  return {
    healthFactor: health === null || health >= UINT256_MAX / 2n ? null : formatHealth(health),
    debt: debt?.toString() ?? null,
    walletBalance: balance?.toString() ?? null,
    allowance: signerState?.allowance ?? null,
    signerPresent: signerState?.signerPresent ?? null,
  };
}

function serialise(rule: ProtectionRule, events: ProtectionEvent[], live: Record<string, unknown> = {}) {
  const maxSpend = BigInt(rule.maxSpend);
  const spent = BigInt(rule.spent);
  return {
    id: rule.id,
    poolAddress: rule.poolAddress,
    positionToken: rule.positionToken,
    triggerHealth: rule.triggerHealth,
    targetHealth: rule.targetHealth,
    maxSpend: rule.maxSpend,
    maxPerCall: rule.maxPerCall,
    spent: rule.spent,
    remaining: (maxSpend > spent ? maxSpend - spent : 0n).toString(),
    enabled: rule.enabled,
    policyId: rule.privyPolicyId,
    signerVerifiedAt: rule.signerVerifiedAt?.toISOString() ?? null,
    lastCheckedAt: rule.lastCheckedAt?.toISOString() ?? null,
    lastActionAt: rule.lastActionAt?.toISOString() ?? null,
    lastNote: rule.lastNote,
    createdAt: rule.createdAt.toISOString(),
    ...live,
    events: events.map((event) => ({
      id: event.id,
      kind: event.kind,
      amount: event.amount,
      healthBefore: event.healthBefore,
      healthAfter: event.healthAfter,
      txHash: event.txHash,
      note: event.note,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}
