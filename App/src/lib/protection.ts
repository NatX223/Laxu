import { ApiError, apiFetch } from "./api";
import { isUserRejection } from "./actions";

/**
 * Loan protection (Spec 05 / 05b): the backend's `/protection` routes, who may see the card, and how errors
 * read to a person. Everything authoritative happens on the server; the browser only shows what it will do.
 * The repay preview lives in ./protectionMath.ts so a script can load it on its own.
 */

export { previewRepay, type PreviewInput, type RepayPreview } from "./protectionMath";

// --- shapes (mirrors Backend/src/routes/protection.ts and services/protection.ts) -------------------

export type ProtectionEventKind = "CREATED" | "PENDING" | "REPAID" | "SKIPPED" | "FAILED" | "ENABLED" | "DISABLED";

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

/** Decided by the backend from the rule and its last event, so the browser never guesses from leftovers. */
export type ProtectionPhase = "setup" | "on" | "off";

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
  phase: ProtectionPhase;
  policyId: string | null;
  signerVerifiedAt: string | null;
  lastCheckedAt: string | null;
  lastActionAt: string | null;
  /** Set when protection could not act ("add AUSD", "Add MON for gas"); shown as a banner. */
  lastNote: string | null;
  createdAt: string;
  // Live figures; any may be null when a read failed.
  healthFactor?: string | null;
  debt?: string | null;
  walletBalance?: string | null;
  /** The wallet's allowance to the pool, on chain. */
  allowance?: string | null;
  /** Whether Laxu's signer is on the wallet right now (null: Privy could not be asked). */
  walletHasSigner?: boolean | null;
  events: ProtectionEvent[];
};

export type ProtectionList = {
  assetDecimals: number;
  assetSymbol: string;
  /** The server's key quorum id: a public id, not a key. */
  signerId: string;
  /** PROTECTION_MAX_SPEND_CAP, debt-asset base units. */
  maxSpendCap: string;
  /** The wallet's MON in wei (it pays the gas for every repay); null if the read failed. */
  walletNativeBalance: string | null;
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

/** Stops the worker. Also how a setup that never finished is cancelled. */
export const disableProtection = (id: string) => apiFetch<ProtectionRule>(`/protection/${id}`, { auth: true, method: "DELETE" });

// --- who sees what (Spec 05b 2) -----------------------------------------------------------------------

export type Eligibility =
  /** Nothing to show: not logged in, no pool yet, or the wallet has not connected. */
  | { kind: "hidden" }
  /** Signed in, but not with a Privy embedded wallet (or not the Laxu wallet). */
  | { kind: "not-embedded" }
  /** Eligible, but there is nothing to protect yet. */
  | { kind: "no-debt" }
  | { kind: "eligible" };

/**
 * `wallet` is the session's wallet (the one matching the user's registered address, or null while it connects),
 * `user` the backend user row, `debt` the pool debt in base units (null before it has loaded).
 * An embedded wallet is `walletClientType === "privy"`.
 */
export function getProtectionEligibility(args: {
  wallet: { address: string; walletClientType: string } | null;
  user: { walletAddress: string } | null;
  debt: bigint | null;
  hasPool: boolean;
}): Eligibility {
  const { wallet, user, debt, hasPool } = args;
  if (!hasPool || !user || !wallet || debt === null) return { kind: "hidden" };
  if (wallet.walletClientType !== "privy" || wallet.address.toLowerCase() !== user.walletAddress.toLowerCase()) {
    return { kind: "not-embedded" };
  }
  return debt > BigInt(0) ? { kind: "eligible" } : { kind: "no-debt" };
}

// --- errors in plain words (Spec 05b 5.4) ---------------------------------------------------------------

export type FriendlyError = { tone: "neutral" | "error"; text: string };

/** The user closed a prompt or refused a wallet transaction. */
export class UserCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "UserCancelled";
  }
}

const CANCEL = /cancel|reject|denied|declin|exit|clos|dismiss|abort/i;

/** True for Privy's "modal closed" and a wallet's "user rejected" alike. */
export function looksCancelled(error: unknown): boolean {
  // A backend answer is never the user backing out, whatever words its message happens to contain.
  if (error instanceof ApiError) return false;
  if (error instanceof UserCancelled || isUserRejection(error)) return true;
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return CANCEL.test(text) || (typeof code === "string" && CANCEL.test(code));
}

/** Never a raw dump: a sentence, with the details left to the console. */
export function friendlyError(error: unknown): FriendlyError {
  if (looksCancelled(error)) return { tone: "neutral", text: "Cancelled. Nothing was changed." };

  if (error instanceof ApiError) {
    switch (error.code) {
      case "NOT_EMBEDDED_WALLET":
        return { tone: "error", text: "Loan protection needs a Laxu wallet created with email sign-in." };
      case "SIGNER_MISSING":
        return { tone: "error", text: "Laxu's permission isn't showing up yet. Wait a few seconds and press Continue." };
      case "ALLOWANCE_TOO_LOW":
        return { tone: "error", text: "The spending limit wasn't set. Press Continue to approve it." };
      case "SIGNER_POLICY_MISMATCH":
        return { tone: "error", text: "The permission on your wallet doesn't match this setup. Cancel the setup and start again." };
    }
    if (error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 429) return { tone: "error", text: error.message };
    if (error.status === 401) return { tone: "error", text: "Your session expired. Sign in again." };
    if (error.status === 503 || error.status === 502 || error.status === 504 || error.status === 429) {
      return { tone: "error", text: "Couldn't reach the service. Nothing was changed. Try again." };
    }
  }
  if (error instanceof TypeError || /failed to fetch|network|timeout|econn/i.test(error instanceof Error ? error.message : "")) {
    return { tone: "error", text: "Couldn't reach the service. Nothing was changed. Try again." };
  }
  console.error("loan protection error", error);
  return { tone: "error", text: "Something went wrong. Nothing was lost; try again." };
}
