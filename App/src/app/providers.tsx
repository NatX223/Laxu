"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { robinhoodTestnet } from "@/lib/chain";
import { env } from "@/lib/env";
import TriggerNotifier from "@/components/TriggerNotifier";
import { NoAuthSessionProvider, SessionProvider } from "@/lib/session";

export function Providers({ children }: { children: React.ReactNode }) {
  // Without an app id Privy refuses to mount at all; keep the public screens up.
  if (!env.privyAppId) return <NoAuthSessionProvider>{children}</NoAuthSessionProvider>;

  return (
    <PrivyProvider
      appId={env.privyAppId}
      config={{
        loginMethods: ["email", "wallet"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: robinhoodTestnet,
        supportedChains: [robinhoodTestnet],
      }}
    >
      <SessionProvider>
        <TriggerNotifier />
        {children}
      </SessionProvider>
    </PrivyProvider>
  );
}
