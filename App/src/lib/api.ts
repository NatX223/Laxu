import { getAccessToken } from "@privy-io/react-auth";
import { env } from "./env";

/** The backend's error envelope: `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The envelope's `details`, e.g. `{ nextClaimAt }` on a faucet 429. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The one way the app calls the Laxu backend. `auth: true` attaches the Privy
 * access token as a bearer, so no authenticated call site can forget it.
 */
export async function apiFetch<T>(
  path: string,
  { auth = false, ...init }: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (auth) {
    const token = await getAccessToken();
    if (!token) throw new ApiError(401, "NOT_LOGGED_IN", "Log in first");
    headers.set("authorization", `Bearer ${token}`);
  }

  const res = await fetch(`${env.apiUrl}${path}`, { ...init, headers });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const error = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, error?.code ?? "HTTP_ERROR", error?.message ?? res.statusText, error?.details);
  }
  return body as T;
}

// --- shapes the backend returns --------------------------------------------

export type LaxuUser = { walletAddress: string; tag: string; createdAt: string };

export type NavPoint = { time: number; navPerToken: string };
export type NavHistory = { entry: NavPoint; points: NavPoint[]; closed: boolean };

/** Open → Closing (unwinding on Arcus) → Settling (returning funds) → Settled (holders claim). */
export type Lifecycle = "open" | "closing" | "settling" | "settled";

export type PublicPosition = {
  positionTokenAddress: string;
  status: "open" | "closed" | "settled";
  lifecycle: Lifecycle;
  symbol: string | null;
  /** Arcus market name, e.g. "ETH-USD". */
  arcusMarket: string | null;
  /** Null when Arcus has no logo — MarketIcon draws a letter avatar. */
  logoUrl: string | null;
  fullAssetName: string | null;
  direction: "long" | "short";
  leverage: number;
  nickname: string;
  /** Set by the creator's on-chain `list()`. Unlisted, only the creator can add to it. */
  listed: boolean;
  /** The creator's wallet address, lowercase. */
  creator: string;
  /** Null while the backend is still retrying createPool — Borrow stays disabled. */
  lendingPoolAddress: string | null;
  entryPrice: string | null;
  /** unix seconds */
  openedAt: number | null;
  closedAt: number | null;
};

export const getNavHistory = (token: string, limit?: number) =>
  apiFetch<NavHistory>(`/positions/${token}/nav-history${limit ? `?limit=${limit}` : ""}`);

export const getPublicPosition = (token: string) => apiFetch<PublicPosition>(`/positions/token/${token}`);

/** A holder's effective stop loss / take profit. Prices are human decimals; null = none. */
export type HolderTriggers = {
  stopLoss: string | null;
  takeProfit: string | null;
  /** True when these are the creator's defaults (or none because they're retired). */
  usingDefault: boolean;
  defaultsActive: boolean;
  defaultStopLoss: string | null;
  defaultTakeProfit: string | null;
  /** The token's stored mark — a level already crossed here is rejected on-chain. */
  markPrice: string | null;
  /** Estimate only: Arcus publishes no liquidation price. */
  estLiquidationPrice: string | null;
};

/** Works with no balance yet, so a buyer can set theirs before the buy-in settles. */
export const getHolderTriggers = (token: string, holder: string) =>
  apiFetch<HolderTriggers>(`/positions/${token}/triggers/${holder}`);

export type TriggerExit = {
  id: string;
  position: { address: string; name: string; nickname: string };
  kind: "stop_loss" | "take_profit";
  /** USDG paid, 2dp. */
  assets: string;
  shares: string;
  txHash: string;
  executedAt: string;
};

/** SL/TP exits for `address` from the last week, newest first. */
export const getTriggerExits = (address: string) =>
  apiFetch<{ triggerExits: TriggerExit[] }>(`/users/${address}/trigger-exits`);

/** USDG already paid to `holder` out of a settled position, human decimal. */
export const getClaimed = (token: string, holder: string) =>
  apiFetch<{ assets: string }>(`/positions/token/${token}/claims/${holder}`);

// --- test funds faucet (testnet only) ---------------------------------------

/** Public: whether to offer test funds at all, even to a signed-out visitor. */
export type FaucetConfig = { enabled: boolean; usdgAmount: string | null };

export type FaucetStatus = {
  enabled: true;
  canClaim: boolean;
  /** ISO time the cooldown (or the per-IP limit) ends; null when `canClaim`. */
  nextClaimAt: string | null;
  /** Human USDG per claim, e.g. "1000". */
  usdgAmount: string;
  /** The user's live on-chain balances, human decimals. */
  balances: { usdg: string; eth: string };
  /** The faucet itself is below its ETH reserve — claims send USDG only. */
  faucetLow: boolean;
};

export type FaucetClaimResult = {
  usdgTxHash: string;
  ethTxHash: string | null;
  /** The faucet was too low on ETH to top the user up; USDG still went out. */
  ethSkipped: boolean;
  nextClaimAt: string;
};

export const getFaucetConfig = () => apiFetch<FaucetConfig>("/faucet/config");
export const getFaucetStatus = () => apiFetch<FaucetStatus>("/faucet/status", { auth: true });
/** No body: the backend always pays the signed-in user's stored wallet. */
export const claimFaucet = () => apiFetch<FaucetClaimResult>("/faucet/claim", { auth: true, method: "POST" });
