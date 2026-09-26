/**
 * The faucet's decisions, kept free of the database and the chain so they can
 * be tested on their own. services/faucet.ts does the I/O around them.
 */

/// At most this many claims from one IP per IP_WINDOW_MS -- stops one person
/// farming with many accounts.
export const IP_CLAIM_LIMIT = 3;
export const IP_WINDOW_MS = 24 * 60 * 60 * 1000;

/// Statuses that count toward the cooldown and the IP limit. A failed claim
/// paid nothing, so the user may retry straight away.
export const ACTIVE_STATUSES = ["pending", "sent"] as const;

export interface ClaimStamp {
  createdAt: Date;
}

/**
 * When this user may claim again, or null if they may claim now.
 *
 * `userClaims` are the user's active claims inside the cooldown window,
 * `ipClaims` the IP's active claims inside IP_WINDOW_MS; any order. Whichever
 * limit frees up LATER wins.
 */
export function nextClaimAt(
  userClaims: ClaimStamp[],
  ipClaims: ClaimStamp[],
  cooldownMs: number,
  now: Date,
): Date | null {
  let next: number | null = null;

  const latestUser = Math.max(...userClaims.map((c) => c.createdAt.getTime()));
  if (userClaims.length > 0 && latestUser + cooldownMs > now.getTime()) {
    next = latestUser + cooldownMs;
  }

  if (ipClaims.length >= IP_CLAIM_LIMIT) {
    // A slot opens when the oldest of the newest IP_CLAIM_LIMIT claims expires.
    const newest = ipClaims
      .map((c) => c.createdAt.getTime())
      .sort((a, b) => b - a)
      .slice(0, IP_CLAIM_LIMIT);
    const freesAt = newest[IP_CLAIM_LIMIT - 1] + IP_WINDOW_MS;
    if (freesAt > now.getTime()) next = Math.max(next ?? 0, freesAt);
  }

  return next === null ? null : new Date(next);
}

export type EthTopUp =
  | { kind: "none" } // already at or above the target
  | { kind: "skip"; amount: bigint } // needed, but would take the faucet under reserve
  | { kind: "send"; amount: bigint };

/// Top the user UP TO `target`; never let the faucet drop below `reserve`.
export function ethTopUp(target: bigint, userBalance: bigint, faucetBalance: bigint, reserve: bigint): EthTopUp {
  const amount = target > userBalance ? target - userBalance : 0n;
  if (amount === 0n) return { kind: "none" };
  if (faucetBalance - amount < reserve) return { kind: "skip", amount };
  return { kind: "send", amount };
}

/// The two RPC errors a stale nonce produces. Worth one retry with a fresh
/// nonce; anything else is a real failure.
export function isNonceError(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return (
    text.includes("nonce too low") ||
    text.includes("nonce has already been used") ||
    text.includes("replacement transaction underpriced") ||
    text.includes("replacement underpriced")
  );
}

/// viem's errors carry a short message plus a long `details`/`cause` chain;
/// search all of it, since RPCs word the nonce errors differently.
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      const details = (current as { details?: unknown }).details;
      if (typeof details === "string") parts.push(details);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" | ");
}

/// A short, user-safe line for the claim row and the API response.
export function shortError(error: unknown): string {
  const short = (error as { shortMessage?: unknown } | null)?.shortMessage;
  const text = typeof short === "string" && short ? short : error instanceof Error ? error.message : String(error);
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/// `::ffff:1.2.3.4` (an IPv4 client on a dual-stack socket) -> `1.2.3.4`, so one
/// client is one key.
export function normaliseIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/// Base units -> fixed decimals, truncated. `formatUnits` alone gives up to 18
/// places for ETH, which is noise in a balance.
export function formatTruncated(value: bigint, decimals: number, places: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").slice(0, places);
  const body = places > 0 ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${body}` : body;
}
