"use client";

import { useMemo } from "react";
import { useSigners } from "@privy-io/react-auth";
import { UserCancelled, looksCancelled } from "./protection";

/**
 * Laxu's server signer on the user's Privy embedded wallet. A thin wrapper over `useSigners()` (the same calls
 * the /dev/privy page used in the Spec 05 spike), so the card deals in two verbs and one error type.
 *
 * Installed @privy-io/react-auth 3.45.0:
 *   addSigners({ address, signers: [{ signerId, policyIds }] }): Promise<{ user }>
 *   removeSigners({ address }): Promise<{ user }>   (removes ALL signers from that wallet)
 * Per the spike, `addSigners` showed no Privy popup on this setup, so the card's own consent text and button
 * are the only consent the user sees. If a prompt does appear, it is Privy's own and a closed one is a cancel.
 *
 * Needs a PrivyProvider above it (the card only mounts when Privy is configured).
 */
export function useLaxuSigner() {
  const { addSigners, removeSigners } = useSigners();

  return useMemo(
    () => ({
      /** Allow the server signer on `walletAddress`, restricted by the policy `policyIds`. */
      async grant(args: { walletAddress: string; signerId: string; policyIds: string[] }): Promise<void> {
        try {
          await addSigners({ address: args.walletAddress, signers: [{ signerId: args.signerId, policyIds: args.policyIds }] });
        } catch (error) {
          throw looksCancelled(error) ? new UserCancelled() : error;
        }
      },
      /** Remove the server signer (and any other) from `walletAddress`. */
      async revoke(args: { walletAddress: string }): Promise<void> {
        try {
          await removeSigners({ address: args.walletAddress });
        } catch (error) {
          throw looksCancelled(error) ? new UserCancelled() : error;
        }
      },
    }),
    [addSigners, removeSigners],
  );
}
