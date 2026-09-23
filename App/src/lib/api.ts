import { getAccessToken } from "@privy-io/react-auth";
import { env } from "./env";

/** The backend's error envelope: `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, error?.code ?? "HTTP_ERROR", error?.message ?? res.statusText);
  }
  return body as T;
}

// --- shapes the backend returns --------------------------------------------

export type LaxuUser = { walletAddress: string; tag: string; createdAt: string };

export type NavPoint = { time: number; navPerToken: string };
export type NavHistory = { entry: NavPoint; points: NavPoint[]; closed: boolean };

export type PublicPosition = {
  positionTokenAddress: string;
  status: "open" | "closed";
  symbol: string | null;
  /** Arcus market name, e.g. "ETH-USD". */
  arcusMarket: string | null;
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
