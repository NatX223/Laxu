import { apiFetch } from "./api";

/**
 * Loan protection (Spec 05): the backend's `/protection` routes and the one piece of maths the card
 * previews with. Everything authoritative happens on the server; this only shows what it will do.
 */

export type ProtectionEventKind = "PENDING" | "REPAID" | "SKIPPED" | "FAILED" | "ENABLED" | "DISABLED";

export type ProtectionEvent = {
  id: string;
  kind: ProtectionEventKind;
  /** Debt-asset base units. */
  amount: string | null;
  healthBefore: string | null;
  healthAfter: string | null;
  txHash: string | null;
  note: string | null;
  createdAt: string;
};

export type ProtectionRule = {
  id: string;
  poolAddress: string;
  positionToken: string;
  triggerHealth: string;
  targetHealth: string;
  /** Debt-asset base units, all of these. */
  maxSpend: string;
  maxPerCall: string;
  spent: string;
  remaining: string;
  enabled: boolean;
  policyId: string | null;
  signerVerifiedAt: string | null;
  lastCheckedAt: string | null;
  lastActionAt: string | null;
  /** Set when protection could not act ("add AUSD"); shown as a banner. */
  lastNote: string | null;
  createdAt: string;
  // Live figures; any may be null when a read failed.
  healthFactor?: string | null;
  debt?: string | null;
  walletBalance?: string | null;
  allowance?: string | null;
  /** Whether Laxu's signer is on the wallet right now (null: Privy could not be asked). */
  signerPresent?: boolean | null;
  events: ProtectionEvent[];
};

export type ProtectionList = {
  assetDecimals: number;
  assetSymbol: string;
  signerId: string;
  rules: ProtectionRule[];
};

export type CreatedProtection = {
  ruleId: string;
  policyId: string;
  signerConfig: { address: string; signers: Array<{ signerId: string; policyIds: string[] }> };
  allowanceToApprove: { token: string; spender: string; amount: string; amountHuman: string };
  maxPerCall: string;
};

export const getProtection = () => apiFetch<ProtectionList>("/protection", { auth: true });

export const createProtection = (body: { pool: string; triggerHealth: string; targetHealth: string; maxSpend: string }) =>
  apiFetch<CreatedProtection>("/protection", { auth: true, method: "POST", body: JSON.stringify(body) });

export const activateProtection = (id: string) =>
  apiFetch<ProtectionRule>(`/protection/${id}/activate`, { auth: true, method: "POST" });

export const turnOffProtection = (id: string) => apiFetch<ProtectionRule>(`/protection/${id}`, { auth: true, method: "DELETE" });

// --- the preview ---------------------------------------------------------------

const WAD = BigInt("1000000000000000000");
const BPS = BigInt(10000);
const ZERO = BigInt(0);
/** Mirrors REPAY_BUFFER_BPS and DUST_FLOOR in Backend/src/services/protectionMath.ts. */
const BUFFER_BPS = BigInt(100);
const DUST_FLOOR = BigInt(10000);

export type RepayPreview = { amount: bigint; reason: "ok" | "healthy" | "no-debt" | "balance" | "dust" };

/**
 * "This would repay about X now": the server's rule (planRepay) restricted to what the browser knows.
 * `targetHealth` is a decimal like "1.30". Only a preview; the backend decides at the time.
 */
export function previewRepay(args: {
  debt: bigint;
  collateralValue: bigint;
  thresholdBps: bigint;
  targetHealth: string;
  maxSpend: bigint;
  walletBalance: bigint;
}): RepayPreview {
  const { debt, collateralValue, thresholdBps, maxSpend, walletBalance } = args;
  if (debt <= ZERO) return { amount: ZERO, reason: "no-debt" };

  const [whole, frac = ""] = args.targetHealth.split(".");
  const targetWad = BigInt(whole) * WAD + BigInt((frac + "0".repeat(18)).slice(0, 18));
  if (targetWad <= ZERO) return { amount: ZERO, reason: "healthy" };

  const target = (collateralValue * thresholdBps * WAD) / (BPS * targetWad);
  const base = debt > target ? debt - target : ZERO;
  if (base === ZERO) return { amount: ZERO, reason: "healthy" };

  let needed = base + (base * BUFFER_BPS + BPS - BigInt(1)) / BPS;
  if (needed > debt) needed = debt;
  const perCall = maxSpend / BigInt(2);

  let amount = needed;
  let reason: RepayPreview["reason"] = "ok";
  if (perCall < amount) amount = perCall;
  if (walletBalance < amount) {
    amount = walletBalance;
    reason = "balance";
  }
  if (amount < DUST_FLOOR) return { amount: ZERO, reason: reason === "balance" ? "balance" : "dust" };
  return { amount, reason };
}
