import type { FaucetClaim, Prisma, User } from "@prisma/client";
import { formatEther, type Address, type Hash, type WalletClient } from "viem";

import { erc20Abi, usdgSelfMintAbi } from "../chain/abi";
import { faucetWallet, publicClient, usdgAddress, withWalletLock } from "../chain/clients";
import { db } from "../config/db";
import { config } from "../config/env";
import { startWorker } from "../lib/async";
import { forbidden, HttpError } from "../lib/errors";
import { createLogger, errorFields } from "../lib/logger";
import { USDG_DECIMALS } from "../lib/units";
import {
  ACTIVE_STATUSES,
  IP_WINDOW_MS,
  ethTopUp,
  formatTruncated,
  isNonceError,
  nextClaimAt,
  shortError,
} from "./faucetRules";

const log = createLogger("faucet");

/**
 * Test funds faucet, testnet only.
 *
 * A new user's embedded wallet holds 0 ETH, so it cannot send anything itself
 * -- not even USDG.mint. The faucet wallet pays for everything: it mints the
 * user FAUCET_USDG_AMOUNT and tops their ETH up to FAUCET_ETH_TARGET_WEI.
 *
 * Every faucet transaction goes through the one in-process queue for the
 * faucet address (withWalletLock), held from nonce to receipt, so two users
 * clicking at once can never clash on a nonce. Correct as long as one backend
 * process sends for the faucet -- how this service is deployed.
 */

const RECEIPT_TIMEOUT_MS = 90_000;
const MONITOR_INTERVAL_MS = 10 * 60_000;
/// Warn once the faucet holds less than this many reserves' worth.
const LOW_BALANCE_RESERVES = 5n;

const cooldownMs = () => config.faucetCooldownHours * 60 * 60 * 1000;
const usdgAmount = () => BigInt(config.faucetUsdgAmount);
const ethTarget = () => BigInt(config.faucetEthTargetWei);
const reserve = () => BigInt(config.faucetMinReserveWei);

export function faucetEnabled(): boolean {
  return config.faucetEnabled;
}

function assertEnabled(): void {
  if (!config.faucetEnabled) throw forbidden("The test funds faucet is switched off", "FAUCET_DISABLED");
}

function signer(): { wallet: WalletClient; address: Address } {
  const wallet = faucetWallet();
  if (!wallet.account) throw new Error("faucet wallet has no account");
  return { wallet, address: wallet.account.address };
}

export function faucetAddress(): Address {
  return signer().address;
}

export async function faucetBalance(): Promise<bigint> {
  return publicClient().getBalance({ address: faucetAddress() });
}

const usdgHuman = (units: bigint) => formatTruncated(units, USDG_DECIMALS, 2).replace(/\.00$/, "");

// ---------------------------------------------------------------------------
// Claim windows
// ---------------------------------------------------------------------------

type Client = Prisma.TransactionClient | typeof db;

/// When `walletAddress` (from `ip`) may claim next, or null for now.
async function claimBlockedUntil(client: Client, walletAddress: string, ip: string | null, now: Date): Promise<Date | null> {
  const select = { createdAt: true } as const;
  const userClaims = await client.faucetClaim.findMany({
    where: {
      walletAddress,
      status: { in: [...ACTIVE_STATUSES] },
      createdAt: { gte: new Date(now.getTime() - cooldownMs()) },
    },
    select,
  });
  const ipClaims = ip
    ? await client.faucetClaim.findMany({
        where: { ip, status: { in: [...ACTIVE_STATUSES] }, createdAt: { gte: new Date(now.getTime() - IP_WINDOW_MS) } },
        select,
      })
    : [];
  return nextClaimAt(userClaims, ipClaims, cooldownMs(), now);
}

function rateLimited(next: Date): HttpError {
  return new HttpError(429, "Test funds already claimed -- try again later", "FAUCET_COOLDOWN", {
    nextClaimAt: next.toISOString(),
  });
}

/**
 * Inserts the `pending` row BEFORE anything is sent. The check and the insert
 * run under transaction-scoped advisory locks on the user and the IP, so two
 * parallel requests (a double-click, or one person's accounts from one IP)
 * serialise here and the second sees the first's row -- a plain transaction
 * would let both read "no claim yet" at READ COMMITTED.
 */
async function reserveClaim(walletAddress: string, ip: string | null): Promise<FaucetClaim> {
  return db.$transaction(async (tx) => {
    // Always user, then IP: one fixed order, so two claims cannot deadlock.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`faucet:user:${walletAddress}`}))`;
    if (ip) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`faucet:ip:${ip}`}))`;

    const blocked = await claimBlockedUntil(tx, walletAddress, ip, new Date());
    if (blocked) throw rateLimited(blocked);

    return tx.faucetClaim.create({
      data: { walletAddress, ip, usdgAmount: usdgAmount().toString(), ethAmountWei: "0", status: "pending" },
    });
  });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Sends one transaction from the faucet with an explicit nonce read from the
 * pending pool. A "nonce too low" / "replacement underpriced" (something else
 * spent from the wallet, or the RPC's view lagged) refetches and retries once.
 * Must run inside the faucet's queue.
 */
async function sendWithNonce(label: string, build: (nonce: number) => Promise<Hash>): Promise<Hash> {
  const { address } = signer();
  const nonce = () => publicClient().getTransactionCount({ address, blockTag: "pending" });

  let hash: Hash;
  try {
    hash = await build(await nonce());
  } catch (error) {
    if (!isNonceError(error)) throw error;
    log.warn(`${label}: nonce rejected, retrying once with a fresh nonce`, errorFields(error));
    hash = await build(await nonce());
  }

  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  if (receipt.status !== "success") throw new Error(`${label} reverted (tx ${hash})`);
  return hash;
}

function inQueue<T>(task: () => Promise<T>): Promise<T> {
  return withWalletLock(faucetAddress(), task);
}

async function writeUsdg(
  label: string,
  call: { abi: readonly unknown[]; functionName: string; args: readonly unknown[] },
): Promise<Hash> {
  const { wallet } = signer();
  const account = wallet.account!;
  return sendWithNonce(label, async (nonce) => {
    // Simulating first turns a revert (a mint cap, say) into a readable error
    // before any gas is spent.
    const { request } = await publicClient().simulateContract({ address: usdgAddress(), account, ...call } as never);
    return wallet.writeContract({ ...(request as object), nonce } as never);
  });
}

/// USDG to `to`, in whichever shape the testnet token's mint takes. Returns
/// the hash of the transaction that credits the user.
async function sendUsdg(to: Address, amount: bigint): Promise<Hash> {
  if (config.faucetUsdgMode === "mint_then_transfer") {
    const mintHash = await inQueue(() =>
      writeUsdg("USDG mint (to faucet)", { abi: usdgSelfMintAbi, functionName: "mint", args: [amount] }),
    );
    log.debug("minted USDG to the faucet", { mintHash });
    return inQueue(() => writeUsdg("USDG transfer", { abi: erc20Abi, functionName: "transfer", args: [to, amount] }));
  }
  return inQueue(() => writeUsdg("USDG mint", { abi: erc20Abi, functionName: "mint", args: [to, amount] }));
}

type EthResult = { hash: Hash | null; amount: bigint; skipped: boolean };

/// Tops `to` up to the ETH target. Both balances are read inside the queue, so
/// the reserve check sees every earlier faucet send already confirmed.
async function topUpEth(to: Address): Promise<EthResult> {
  return inQueue(async () => {
    const [userBalance, faucetBal] = await Promise.all([publicClient().getBalance({ address: to }), faucetBalance()]);
    const plan = ethTopUp(ethTarget(), userBalance, faucetBal, reserve());
    if (plan.kind === "none") return { hash: null, amount: 0n, skipped: false };
    if (plan.kind === "skip") {
      log.warn("faucet below reserve; skipping the ETH top-up", {
        to,
        needed: plan.amount,
        faucetBalance: faucetBal,
        reserve: reserve(),
      });
      return { hash: null, amount: 0n, skipped: true };
    }

    const { wallet } = signer();
    const hash = await sendWithNonce("ETH top-up", (nonce) =>
      wallet.sendTransaction({ account: wallet.account!, chain: wallet.chain, to, value: plan.amount, nonce }),
    );
    return { hash, amount: plan.amount, skipped: false };
  });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface FaucetStatus {
  enabled: true;
  canClaim: boolean;
  nextClaimAt: string | null;
  usdgAmount: string;
  balances: { usdg: string; eth: string };
  faucetLow: boolean;
}

/// `GET /faucet/status`. Balances are read live from the chain.
export async function faucetStatus(user: User, ip: string | null): Promise<FaucetStatus> {
  assertEnabled();
  const address = user.walletAddress as Address;
  const [blocked, usdg, eth, faucetBal] = await Promise.all([
    claimBlockedUntil(db, user.walletAddress, ip, new Date()),
    publicClient().readContract({ address: usdgAddress(), abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    publicClient().getBalance({ address }),
    faucetBalance(),
  ]);
  return {
    enabled: true,
    canClaim: blocked === null,
    nextClaimAt: blocked?.toISOString() ?? null,
    usdgAmount: usdgHuman(usdgAmount()),
    balances: { usdg: formatTruncated(usdg, USDG_DECIMALS, 2), eth: formatTruncated(eth, 18, 6) },
    faucetLow: faucetBal < reserve(),
  };
}

export interface ClaimResult {
  usdgTxHash: Hash;
  ethTxHash: Hash | null;
  ethSkipped: boolean;
  nextClaimAt: string;
}

/**
 * `POST /faucet/claim`. The address is always the signed-in user's stored
 * wallet -- never anything from the request.
 */
export async function claimTestFunds(user: User, ip: string | null): Promise<ClaimResult> {
  assertEnabled();
  const to = user.walletAddress as Address;
  const claim = await reserveClaim(user.walletAddress, ip);
  const amount = BigInt(claim.usdgAmount);
  log.info("claim started", { claimId: claim.id, to, ip });

  let usdgTxHash: Hash | undefined;
  let eth: EthResult | undefined;
  try {
    usdgTxHash = await sendUsdg(to, amount);
    eth = await topUpEth(to);

    await db.faucetClaim.update({
      where: { id: claim.id },
      data: {
        status: "sent",
        usdgTxHash,
        ethTxHash: eth.hash,
        ethAmountWei: eth.amount.toString(),
        ethSkipped: eth.skipped,
      },
    });
    log.info("claim sent", { claimId: claim.id, to, usdgTxHash, ethTxHash: eth.hash, ethWei: eth.amount });
    return {
      usdgTxHash,
      ethTxHash: eth.hash,
      ethSkipped: eth.skipped,
      nextClaimAt: new Date(claim.createdAt.getTime() + cooldownMs()).toISOString(),
    };
  } catch (error) {
    const message = shortError(error);
    // A failed claim does not count toward the cooldown, so the user can retry.
    await db.faucetClaim
      .update({ where: { id: claim.id }, data: { status: "failed", error: message, usdgTxHash: usdgTxHash ?? null } })
      .catch((dbError) => log.error("could not mark the claim failed", { claimId: claim.id, ...errorFields(dbError) }));

    const faucetLow = await faucetBalance()
      .then((balance) => balance < reserve())
      .catch(() => false);
    log.error("claim failed", { claimId: claim.id, to, usdgSent: Boolean(usdgTxHash), faucetLow, ...errorFields(error) });

    if (!usdgTxHash && faucetLow) {
      throw new HttpError(503, "The test funds faucet is out of gas -- the team has been alerted", "FAUCET_EMPTY", {
        reason: message,
      });
    }
    throw new HttpError(502, `Couldn't send test funds: ${message}`, "FAUCET_SEND_FAILED", { reason: message });
  }
}

// ---------------------------------------------------------------------------
// Admin + monitoring
// ---------------------------------------------------------------------------

export async function faucetSummary() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [balance, byStatus, failures] = await Promise.all([
    config.faucetPrivateKey ? faucetBalance() : Promise.resolve(null),
    db.faucetClaim.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    db.faucetClaim.findMany({ where: { status: "failed" }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  const counts = Object.fromEntries(byStatus.map((row) => [row.status, row._count._all]));
  return {
    enabled: config.faucetEnabled,
    address: config.faucetPrivateKey ? faucetAddress() : null,
    balanceWei: balance?.toString() ?? null,
    balanceEth: balance === null ? null : formatEther(balance),
    reserveWei: reserve().toString(),
    low: balance === null ? null : balance < reserve() * LOW_BALANCE_RESERVES,
    claimsLast24h: {
      total: byStatus.reduce((sum, row) => sum + row._count._all, 0),
      sent: counts.sent ?? 0,
      pending: counts.pending ?? 0,
      failed: counts.failed ?? 0,
    },
    recentFailures: failures.map((row) => ({
      id: row.id,
      walletAddress: row.walletAddress,
      ip: row.ip,
      error: row.error,
      usdgTxHash: row.usdgTxHash,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/**
 * Boot: fail any claim a previous process left `pending` (it can no longer
 * finish it, and a pending row blocks the user), then log the faucet's address
 * and balance and re-check it every 10 minutes.
 */
export function startFaucetMonitor(): () => void {
  void db.faucetClaim
    .updateMany({ where: { status: "pending" }, data: { status: "failed", error: "Interrupted by a backend restart" } })
    .then(({ count }) => {
      if (count > 0) log.warn("failed claims a restart left pending", { count });
    })
    .catch((error) => log.error("could not clear pending claims", errorFields(error)));

  let first = true;
  return startWorker(
    "faucet-monitor",
    MONITOR_INTERVAL_MS,
    async () => {
      const balance = await faucetBalance();
      const fields = { address: faucetAddress(), balanceEth: formatEther(balance), reserveEth: formatEther(reserve()) };
      if (first) log.info("faucet ready", fields);
      first = false;
      if (balance < reserve()) log.error("faucet is below its reserve -- ETH top-ups are paused; refill it", fields);
      else if (balance < reserve() * LOW_BALANCE_RESERVES) log.warn("faucet ETH is running low; refill it", fields);
    },
    (error) => log.error("faucet balance check failed", errorFields(error)),
  );
}
