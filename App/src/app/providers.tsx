"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { monadTestnet } from "@/lib/chain";
import { env } from "@/lib/env";
import TriggerNotifier from "@/components/TriggerNotifier";
import { FaucetProvider } from "@/lib/faucet";
import { NoAuthSessionProvider, SessionProvider } from "@/lib/session";

export function Providers({ children }: { children: React.ReactNode }) {
  // Without an app id Privy refuses to mount at all; keep the public screens up.
  if (!env.privyAppId) return <NoAuthSessionProvider>{children}</NoAuthSessionProvider>;

  return (
    <PrivyProvider
      appId={env.privyAppId}
      config={{
        loginMethods: ["email", "wallet", "google"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: monadTestnet,
        supportedChains: [monadTestnet],
      }}
    >
      <SessionProvider>
        <FaucetProvider>
          <TriggerNotifier />
          {children}
        </FaucetProvider>
      </SessionProvider>
    </PrivyProvider>
  );
}
