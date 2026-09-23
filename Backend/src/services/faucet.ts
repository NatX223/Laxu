import { parseEther, type Address, type Hash } from "viem";

import { faucetWallet, publicClient } from "../chain/clients";
import { config } from "../config/env";
import { createLogger, errorFields } from "../lib/logger";

const log = createLogger("faucet");

/**
 * Testnet gas drip for new users.
 *
 * An email user's embedded wallet starts with zero native gas, so it cannot
 * sign a single transaction. Called only when a user row is CREATED, never on
 * later logins, so reloading the page cannot farm it -- and skipped when the
 * wallet already holds enough (external wallets usually do).
 *
 * Gas only; testnet USDG for testers is a separate, still-open item.
 */
export async function dripGas(to: string): Promise<Hash | null> {
  if (!config.faucetPrivateKey) {
    log.debug("FAUCET_PRIVATE_KEY unset; skipping gas drip", { to });
    return null;
  }

  const address = to as Address;
  const balance = await publicClient().getBalance({ address });
  if (balance >= parseEther(config.faucetMinBalanceEth)) {
    log.debug("wallet already holds gas; skipping drip", { to, balance: balance.toString() });
    return null;
  }

  const wallet = faucetWallet();
  if (!wallet.account) throw new Error("faucet wallet has no account");

  const hash = await wallet.sendTransaction({
    account: wallet.account,
    chain: wallet.chain,
    to: address,
    value: parseEther(config.faucetDripEth),
  });
  log.info("gas drip sent", { to, amountEth: config.faucetDripEth, hash });
  return hash;
}

/// Fire-and-forget wrapper for the login path: a dry faucet or a slow RPC must
/// never fail -- or stall -- the user's sign-in.
export function dripGasInBackground(to: string): void {
  void dripGas(to).catch((error) => log.error("gas drip failed", { to, ...errorFields(error) }));
}
