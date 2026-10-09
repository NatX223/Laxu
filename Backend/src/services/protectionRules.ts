import { toBaseUnits } from "../lib/decimal";
import {
  DUST_FLOOR,
  formatHealth,
  healthToWad,
  planRepay,
  type Limit,
  type RepayPlan,
} from "./protectionMath";

/**
 * Loan protection rules: input validation (Spec 05 2.3) and the per-tick decision (2.5).
 * Pure: the worker in protection.ts does the reading and sending around it.
 */

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const TRIGGER_MIN = healthToWad("1.05");
export const TRIGGER_MAX = healthToWad("3.0");
export const TARGET_GAP_MIN = healthToWad("0.10"); // target >= trigger + 0.10
export const TARGET_MAX = healthToWad("5.0");

export class ProtectionInputError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ProtectionInputError";
  }
}

export interface RuleInput {
  triggerHealth: string;
  targetHealth: string;
  /// A human amount of the debt asset ("25" or "25.5").
  maxSpend: string;
}

export interface ValidRule {
  triggerHealth: string;
  targetHealth: string;
  triggerWad: bigint;
  targetWad: bigint;
  /// Debt-asset base units. Also the allowance the user approves.
  maxSpend: bigint;
  /// min(maxSpend, maxSpend / 2): one call can never spend everything.
  maxPerCall: bigint;
}

/// `decimals` is the debt asset's (6 for AUSD); `cap` is PROTECTION_MAX_SPEND_CAP in base units.
export function validateRuleInput(input: RuleInput, decimals: number, cap: bigint): ValidRule {
  let triggerWad: bigint;
  let targetWad: bigint;
  try {
    triggerWad = healthToWad(input.triggerHealth);
    targetWad = healthToWad(input.targetHealth);
  } catch {
    throw new ProtectionInputError("Health factors must be plain numbers like 1.15", "INVALID_HEALTH");
  }
  const show = (wad: bigint) => formatHealth(wad)!.replace(/0+$/, "").replace(/\.$/, ".0");
  if (triggerWad < TRIGGER_MIN || triggerWad > TRIGGER_MAX) {
    throw new ProtectionInputError(`Trigger health must be between ${show(TRIGGER_MIN)} and ${show(TRIGGER_MAX)}`, "INVALID_TRIGGER");
  }
  if (targetWad < triggerWad + TARGET_GAP_MIN) {
    throw new ProtectionInputError("Target health must be at least 0.10 above the trigger", "INVALID_TARGET");
  }
  if (targetWad > TARGET_MAX) {
    throw new ProtectionInputError(`Target health can be at most ${show(TARGET_MAX)}`, "INVALID_TARGET");
  }

  let maxSpend: bigint;
  try {
    if (!/^\d+(\.\d+)?$/.test(input.maxSpend.trim())) throw new Error("not a decimal");
    maxSpend = toBaseUnits(input.maxSpend.trim(), decimals);
  } catch {
    throw new ProtectionInputError("Max total spend must be a plain amount like 25 or 25.5", "INVALID_MAX_SPEND");
  }
  if (maxSpend <= 0n) throw new ProtectionInputError("Max total spend must be above zero", "INVALID_MAX_SPEND");
  if (maxSpend > cap) {
    throw new ProtectionInputError(`Max total spend is capped at ${baseToHuman(cap, decimals)}`, "MAX_SPEND_TOO_HIGH");
  }
  const maxPerCall = maxSpend / 2n;
  if (maxPerCall < DUST_FLOOR) {
    throw new ProtectionInputError(
      `Max total spend is too small to be useful (at least ${baseToHuman(DUST_FLOOR * 2n, decimals)})`,
      "MAX_SPEND_TOO_LOW",
    );
  }

  return {
    triggerHealth: formatHealth(triggerWad)!,
    targetHealth: formatHealth(targetWad)!,
    triggerWad,
    targetWad,
    maxSpend,
    maxPerCall,
  };
}

export function baseToHuman(units: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const frac = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// ---------------------------------------------------------------------------
// The per-tick decision
// ---------------------------------------------------------------------------

export interface RuleView {
  enabled: boolean;
  /// Rule 7: never act on a rule whose signer was not verified by the backend.
  signerVerified: boolean;
  /// Rule 7: the user's resolved wallet is still the rule's wallet.
  walletMatchesUser: boolean;
  triggerWad: bigint;
  targetWad: bigint;
  maxSpend: bigint;
  maxPerCall: bigint;
  spent: bigint;
  lastActionAtMs: number | null;
}

export interface Basics {
  debt: bigint;
  /// 1e18-scaled; uint256 max when there is no debt.
  health: bigint;
}

export interface Detail {
  collateralValue: bigint;
  thresholdBps: bigint;
  balance: bigint;
  allowance: bigint;
}

/// Chain reads, lazily: the second one is only paid for when a repay is actually on the table.
export interface Reader {
  basics(): Promise<Basics>;
  detail(): Promise<Detail>;
}

/// "gas": the user's wallet cannot pay the MON fee for the repay (decided by the worker, not by `decide`).
export type SkipReason = Limit | "dust" | "gas";

export type Decision =
  | { kind: "idle"; why: "disabled" | "signer-unverified" | "wallet-mismatch" }
  | { kind: "no-debt" }
  | { kind: "healthy"; health: bigint }
  | { kind: "cooldown"; retryInS: number; health: bigint }
  | { kind: "skip"; reason: SkipReason; health: bigint; plan: RepayPlan }
  | { kind: "repay"; amount: bigint; health: bigint; plan: RepayPlan };

export async function decide(rule: RuleView, read: Reader, nowMs: number, cooldownS: number): Promise<Decision> {
  if (!rule.enabled) return { kind: "idle", why: "disabled" };
  if (!rule.signerVerified) return { kind: "idle", why: "signer-unverified" };
  if (!rule.walletMatchesUser) return { kind: "idle", why: "wallet-mismatch" };

  const { debt, health } = await read.basics();
  if (debt === 0n) return { kind: "no-debt" };
  if (health > rule.triggerWad) return { kind: "healthy", health };

  if (rule.lastActionAtMs !== null) {
    const waitMs = rule.lastActionAtMs + cooldownS * 1000 - nowMs;
    if (waitMs > 0) return { kind: "cooldown", retryInS: Math.ceil(waitMs / 1000), health };
  }

  const detail = await read.detail();
  const plan = planRepay({
    debt,
    collateralValue: detail.collateralValue,
    thresholdBps: detail.thresholdBps,
    targetHealth: rule.targetWad,
    maxPerCall: rule.maxPerCall,
    remainingSpend: rule.maxSpend > rule.spent ? rule.maxSpend - rule.spent : 0n,
    balance: detail.balance,
    allowance: detail.allowance,
  });

  if (plan.amount > 0n) return { kind: "repay", amount: plan.amount, health, plan };
  // already-at-target can only mean health sat at or below the trigger by rounding; nothing to do or say.
  if (plan.reason === "already-at-target") return { kind: "healthy", health };
  const reason: SkipReason = plan.limitedBy ?? "dust";
  return { kind: "skip", reason, health, plan };
}

/// What the user sees when protection cannot act. Plain words, no jargon.
export function skipNote(reason: SkipReason, assetSymbol: string, maxSpend: bigint, decimals: number): string {
  switch (reason) {
    case "balance":
      return `Protection could not act: add ${assetSymbol} to your wallet so it can repay.`;
    case "allowance":
      return "Protection could not act: its spending allowance is used up. Turn protection off and set it up again.";
    case "remainingSpend":
      return `Protection stopped: the total spend limit (${baseToHuman(maxSpend, decimals)} ${assetSymbol}) is used up.`;
    case "maxPerCall":
      return "Protection could not act: the per-repay limit is too small to matter.";
    case "dust":
      return "Protection has nothing worth repaying right now.";
    case "gas":
      return "Add MON for gas: Laxu's repay is sent from your wallet, so your wallet pays the fee.";
  }
}

/// The MON a wallet is missing to pay `gasLimit` at up to `maxFeePerGas` (wei), or null when it has enough.
/// Monad bills the gas limit rather than gas used, so the limit times the fee cap is the right bar.
export function gasShortfall(balance: bigint, gasLimit: bigint, maxFeePerGas: bigint): bigint | null {
  const required = gasLimit * maxFeePerGas;
  return balance >= required ? null : required - balance;
}

/// What POST /protection writes onto a rule that already exists for (wallet, pool) -- one that was turned off
/// or never finished -- and onto a new one: a clean slate, so a re-created rule can never inherit `spent`,
/// a verified signer or a stale banner from the last one (Spec 05b 6.2).
export function ruleResetData(valid: ValidRule, policyId: string, privyWalletId: string) {
  return {
    triggerHealth: valid.triggerHealth,
    targetHealth: valid.targetHealth,
    maxSpend: valid.maxSpend.toString(),
    maxPerCall: valid.maxPerCall.toString(),
    spent: "0",
    privyPolicyId: policyId,
    privyWalletId,
    enabled: false,
    signerVerifiedAt: null,
    lastActionAt: null,
    lastCheckedAt: null,
    lastNote: null,
  };
}

// ---------------------------------------------------------------------------
// Event bookkeeping
// ---------------------------------------------------------------------------

/// A "could not act" note is written at most once per cooldown window.
export function shouldRecordSkip(
  last: { kind: string; note: string | null; createdAtMs: number } | null,
  note: string,
  nowMs: number,
  cooldownS: number,
): boolean {
  if (!last || last.kind !== "SKIPPED" || last.note !== note) return true;
  return nowMs - last.createdAtMs >= cooldownS * 1000;
}

/// A PENDING event is the in-flight marker for a repay: while it is fresh the rule is skipped;
/// past `staleMs` the process that wrote it is assumed dead and the worker settles it from the chain.
export function pendingState(createdAtMs: number, nowMs: number, staleMs: number): "in-flight" | "stale" {
  return nowMs - createdAtMs < staleMs ? "in-flight" : "stale";
}
