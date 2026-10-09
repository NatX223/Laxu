/**
 * Who sees what on the Protect-this-loan card (Spec 05b 2). Pure and dependency-free so a script can test it;
 * `lib/protection.ts` re-exports it, which is where the card imports it from.
 */

export type Eligibility =
  /** Nothing to show: not logged in, no pool yet, or the wallet has not connected / the debt has not loaded. */
  | { kind: "hidden" }
  /** Signed in, but not with a Privy embedded wallet (or not the Laxu wallet). */
  | { kind: "not-embedded" }
  /** Eligible, but there is nothing to protect yet. */
  | { kind: "no-debt" }
  | { kind: "eligible" };

/**
 * `wallet` is the session's wallet (the one matching the user's registered address, or null while it connects),
 * `user` the backend user row, `debt` the pool debt in base units (null before it has loaded).
 * A Privy embedded wallet has `walletClientType === "privy"` (ConnectedWallet in @privy-io/react-auth 3.45.0).
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
