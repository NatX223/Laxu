import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  erc20Abi,
  hexToString,
  parseUnits,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { lendingPoolAbi, lendingVaultAbi, positionTokenAbi } from "./abi.generated";
import { apiFetch, type PublicPosition } from "./api";
import { publicClient } from "./chain";
import { env } from "./env";
import type { LaxuWalletClient } from "./walletClient";

/**
 * Every on-chain action a user signs themselves. The backend never holds or
 * moves a user's funds; it only fulfils the async requests these create.
 *
 * Each helper waits for its receipt before resolving. For the async ones
 * (`requestDeposit` / `requestRedeem` / `requestClose`) a receipt only means
 * *requested* — the UI shows "Settling on Perpl…" until the backend fulfils
 * it. The fulfil mints the tokens (buy-in) or pays the asset (redeem) straight
 * to the wallet that asked. The one claim step is after a position closes and
 * settles: the backend pushes each holder's payout, and `claim()` is the
 * fallback for anyone it didn't reach.
 */

// --- ABIs: generated from the compiled contracts (npm run abi:gen) ----------

/** PositionToken.REQUEST_CANCEL_TIMEOUT: an unfulfilled request can be taken back after this. */
export const REQUEST_CANCEL_TIMEOUT_S = 20 * 60;
/** PositionToken.MAX_NICKNAME_LENGTH, in bytes. */
export const MAX_NICKNAME_BYTES = 32;
/** PositionToken.BUY_IN_FEE_BPS — 2%, paid to the creator; the creator pays none on their own position. */
export const BUY_IN_FEE_BPS = 200;

// --- plumbing ---------------------------------------------------------------

function assetAddr(): Address {
  if (!env.assetAddress) throw new Error("NEXT_PUBLIC_ASSET_ADDRESS is not set");
  return env.assetAddress as Address;
}

/**
 * Shown in place of LendingPool's "stale oracle data" revert. The pool prices
 * its collateral off the position token, which reads Perpl's mark on-chain; it
 * refuses risk-adding calls when that mark or the funding update is stale.
 */
export const STALE_ORACLE_MESSAGE = "Borrowing is paused: the Perpl price or funding update is stale. Try again shortly.";

/**
 * One line for the user from whatever a write threw: a wallet rejection, the
 * revert reason for a revert, otherwise viem's short message. A stale
 * LendingPool oracle gets its own plain-language line.
 */
export function txErrorMessage(error: unknown): string {
  if (isUserRejection(error)) return "Cancelled in your wallet";
  const text = errorText(error);
  if (text.includes("stale oracle data")) return STALE_ORACLE_MESSAGE;
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.reason) return revert.reason;
    const reason = /reverted with the following reason:\s*([^\n]+)/.exec(text)?.[1];
    if (reason) return reason.trim();
    return error.shortMessage;
  }
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}

/** The user closed or refused the wallet prompt. */
export function isUserRejection(error: unknown): boolean {
  if (error instanceof BaseError && error.walk((e) => e instanceof UserRejectedRequestError)) return true;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 4001 || code === "ACTION_REJECTED") return true;
  return /user rejected|user denied|rejected the request|request rejected/i.test(errorText(error));
}

function errorText(error: unknown): string {
  if (error instanceof BaseError) return `${error.shortMessage}\n${error.details ?? ""}\n${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

async function confirm(hash: Hash): Promise<Hash> {
  const receipt = await publicClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return hash;
}

/**
 * Approve `spender` for exactly `amount` of `token` — never unlimited, since
 * testers are trusting a week-old contract — and skip the prompt entirely when
 * the current allowance already covers it. Must land before the call it
 * unlocks, so it is awaited to its receipt.
 */
export async function approveIfNeeded(
  wallet: LaxuWalletClient,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<Hash | null> {
  const allowance = await publicClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [wallet.account.address, spender],
  });
  if (allowance >= amount) return null;
  return confirm(
    await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  );
}

/**
 * Set `spender`'s allowance of `token` to EXACTLY `amount` (0 revokes it), whatever it was before.
 * Loan protection needs this rather than {@link approveIfNeeded}: that skips the prompt when a bigger
 * allowance already exists, which would leave the on-chain spending cap larger than the one the user chose.
 * Never max-uint; the amount is the rule's maxSpend, what is left of it, or 0.
 */
export async function setExactAllowance(wallet: LaxuWalletClient, token: Address, spender: Address, amount: bigint): Promise<Hash | null> {
  const current = await publicClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [wallet.account.address, spender],
  });
  if (current === amount) return null;
  return confirm(
    await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  );
}

// --- open -------------------------------------------------------------------

export type OpenReservation = {
  openRequestId: string;
  /** The reserved slot's wallet — where the collateral asset goes. */
  payTo: string;
  /** The asset's address; checked against the one this app was built for before anything is sent. */
  asset: string;
  /** Asset base units. */
  amount: string;
  expiresAt: string;
};

export type OpenRequestStatus =
  | "awaiting_payment"
  | "payment_received"
  | "deposited"
  | "order_filled"
  | "minted"
  | "refunding"
  | "refunded"
  | "failed";

export type OpenRequest = {
  openRequestId: string;
  status: OpenRequestStatus;
  symbol: string | null;
  direction: "long" | "short";
  leverage: number;
  amount: string;
  creditedAmount: string | null;
  /** The Perpl fill, human decimals; set from `order_filled` on. */
  entryPrice: string | null;
  filledSize: string | null;
  paymentTxHash: string | null;
  positionTokenAddress: string | null;
  lendingPoolAddress: string | null;
  refundTxHash: string | null;
  error: string | null;
};

/**
 * Open a position: reserve a Perpl account slot, pay its wallet with a plain
 * asset transfer, then report the transaction. The backend deposits it on
 * Perpl, trades, and mints the token; poll {getOpenRequest} until `minted`
 * (then go to the position page) or `refunded`.
 *
 * `wallet` must be the wallet the backend knows as this user — the payment is
 * checked against it — which is what the session's `wallet` is.
 *
 * `hooks.onReserved` fires before the wallet prompt and `hooks.onSubmitted` as
 * soon as the transfer has a hash, so the caller can persist the request id
 * (and hash) and resume after a page refresh: a transfer that landed but was
 * never reported is re-reported with {reportOpenPayment}.
 */
export async function openPosition(
  wallet: LaxuWalletClient,
  request: {
    market: string;
    direction: "long" | "short";
    leverage: number;
    /** human amount of the asset, e.g. "500" */
    amount: string;
    /** The creator's SL/TP as human prices ("1900") — the default for everyone who buys in. */
    stopLoss?: string;
    takeProfit?: string;
  },
  hooks: {
    onReserved?: (reservation: OpenReservation) => void;
    onSubmitted?: (reservation: OpenReservation, hash: Hash) => void;
  } = {},
): Promise<{ reservation: OpenReservation; hash: Hash }> {
  const reservation = await apiFetch<OpenReservation>("/positions/open", {
    auth: true,
    method: "POST",
    body: JSON.stringify(request),
  });
  hooks.onReserved?.(reservation);

  // Never pay a lapsed reservation (the slot may be someone else's by now) or
  // one asking for a token other than the asset this app was built against.
  if (Date.parse(reservation.expiresAt) <= Date.now()) {
    throw new ReservationRejected("The trading slot reservation expired before payment. Try again.");
  }
  if (reservation.asset.toLowerCase() !== assetAddr().toLowerCase()) {
    throw new ReservationRejected("The backend asked for payment in an unexpected token, so nothing was sent.");
  }

  const hash = await wallet.writeContract({
    address: reservation.asset as Address,
    abi: erc20Abi,
    functionName: "transfer",
    args: [reservation.payTo as Address, BigInt(reservation.amount)],
  });
  hooks.onSubmitted?.(reservation, hash);
  await confirm(hash);
  await reportOpenPayment(reservation.openRequestId, hash);
  return { reservation, hash };
}

/** Thrown before any funds move: the reservation can't safely be paid. */
export class ReservationRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReservationRejected";
  }
}

/** Tell the backend the asset transfer for `openRequestId` landed. Idempotent for the same hash. */
export const reportOpenPayment = (openRequestId: string, txHash: Hash) =>
  apiFetch<OpenRequest>(`/positions/open/${openRequestId}/paid`, {
    auth: true,
    method: "POST",
    body: JSON.stringify({ txHash }),
  });

export const getOpenRequest = (openRequestId: string) =>
  apiFetch<OpenRequest>(`/positions/open/${openRequestId}`, { auth: true });

// --- position token ---------------------------------------------------------

/**
 * Buy in / add margin: approve the asset to the token, then queue the deposit.
 * Others can only buy into a listed position (2% of the amount goes to the
 * creator); the creator can top up their own position any time, fee-free.
 */
export async function buyIn(wallet: LaxuWalletClient, positionToken: Address, assets: bigint): Promise<Hash> {
  const me = wallet.account.address;
  await approveIfNeeded(wallet, assetAddr(), positionToken, assets);
  return confirm(
    await wallet.writeContract({
      address: positionToken,
      abi: positionTokenAbi,
      functionName: "requestDeposit",
      args: [assets, me, me],
    }),
  );
}

/** Exit a stake. */
export async function exitStake(wallet: LaxuWalletClient, positionToken: Address, shares: bigint): Promise<Hash> {
  const me = wallet.account.address;
  return confirm(
    await wallet.writeContract({
      address: positionToken,
      abi: positionTokenAbi,
      functionName: "requestRedeem",
      args: [shares, me, me],
    }),
  );
}

/**
 * Close — creator only, holding 100% of supply with no buy-in pending (tokens
 * posted as loan collateral don't count: repay and withdraw them first). A
 * listed creator who has bought everyone back out may close too.
 */
export async function closePosition(wallet: LaxuWalletClient, positionToken: Address): Promise<Hash> {
  return confirm(
    await wallet.writeContract({ address: positionToken, abi: positionTokenAbi, functionName: "requestClose" }),
  );
}

/** List for buy-ins. One-way; the nickname is set here once and never again. */
export async function listPosition(wallet: LaxuWalletClient, positionToken: Address, nickname: string): Promise<Hash> {
  if (new TextEncoder().encode(nickname).length > MAX_NICKNAME_BYTES) {
    throw new Error(`Nickname must be at most ${MAX_NICKNAME_BYTES} bytes`);
  }
  return confirm(
    await wallet.writeContract({ address: positionToken, abi: positionTokenAbi, functionName: "list", args: [nickname] }),
  );
}

/** Take back an unfulfilled buy-in after {REQUEST_CANCEL_TIMEOUT_S}. The 2% fee is not refunded. */
export async function cancelDepositRequest(wallet: LaxuWalletClient, positionToken: Address): Promise<Hash> {
  return confirm(
    await wallet.writeContract({ address: positionToken, abi: positionTokenAbi, functionName: "cancelDepositRequest" }),
  );
}

/** Take back an unfulfilled redeem after {REQUEST_CANCEL_TIMEOUT_S}: the shares are re-minted. */
export async function cancelRedeemRequest(wallet: LaxuWalletClient, positionToken: Address): Promise<Hash> {
  return confirm(
    await wallet.writeContract({ address: positionToken, abi: positionTokenAbi, functionName: "cancelRedeemRequest" }),
  );
}

// --- stop loss / take profit ------------------------------------------------

/** PositionToken.PRICE_SCALE: trigger levels go on-chain as 1e18 fixed point. */
const PRICE_DECIMALS = 18;

/**
 * Set this wallet's own SL/TP (human prices; "" or undefined = none for that
 * side). Covers the tokens in the wallet only — not any posted as loan
 * collateral. Works before a buy-in settles, too.
 */
export async function setTriggers(
  wallet: LaxuWalletClient,
  positionToken: Address,
  levels: { stopLoss?: string; takeProfit?: string },
): Promise<Hash> {
  const price = (value?: string) => (value && value.trim() ? parseUnits(value.trim(), PRICE_DECIMALS) : BigInt(0));
  return confirm(
    await wallet.writeContract({
      address: positionToken,
      abi: positionTokenAbi,
      functionName: "setTriggers",
      args: [price(levels.stopLoss), price(levels.takeProfit)],
    }),
  );
}

/** No triggers at all, including the creator's defaults. */
export async function clearTriggers(wallet: LaxuWalletClient, positionToken: Address): Promise<Hash> {
  return confirm(
    await wallet.writeContract({ address: positionToken, abi: positionTokenAbi, functionName: "clearTriggers" }),
  );
}

/** Drop personal levels and follow the creator's defaults again. */
export async function resetTriggersToDefault(wallet: LaxuWalletClient, positionToken: Address): Promise<Hash> {
  return confirm(
    await wallet.writeContract({ address: positionToken, abi: positionTokenAbi, functionName: "useDefaultTriggers" }),
  );
}

/** Take this wallet's share of a settled position. The payout always goes to the caller. */
export async function claimSettlement(wallet: LaxuWalletClient, positionToken: Address): Promise<Hash> {
  return confirm(
    await wallet.writeContract({ address: positionToken, abi: positionTokenAbi, functionName: "claim" }),
  );
}

/**
 * The token's own read of Perpl's mark price, on-chain (`currentMark()`).
 * `price` is human USD; `live` is false when Perpl could not be read and
 * `price` is the last known one. This is also the price the contract checks a
 * stop loss / take profit against.
 */
export async function readCurrentMark(positionToken: Address): Promise<{ price: number; live: boolean }> {
  const [price, live] = await publicClient().readContract({
    address: positionToken,
    abi: positionTokenAbi,
    functionName: "currentMark",
  });
  return { price: Number(price) / 1e18, live };
}

/**
 * A position rebuilt from the token alone, for when the Laxu backend can't be
 * reached: what the page needs to keep showing the live mark, NAV and the
 * holder's own actions. What only the backend's index knows (the lending pool
 * address, logos, open and close times) is left empty here; the caller fills
 * it from a cached copy if it has one.
 */
export async function readPositionFromChain(positionToken: Address): Promise<PublicPosition> {
  const read = <T>(functionName: string) =>
    publicClient().readContract({ address: positionToken, abi: positionTokenAbi, functionName } as never) as Promise<T>;
  const [market, direction, leverage, creator, nickname, listed, closed, settled, closeRequested, entry] = await Promise.all([
    read<string>("market"),
    read<number>("direction"),
    read<bigint>("leverage"),
    read<string>("creator"),
    read<string>("nickname"),
    read<boolean>("listed"),
    read<boolean>("closed"),
    read<boolean>("settled"),
    read<boolean>("closeRequested"),
    read<bigint>("entryPrice"),
  ]);
  const symbol = hexToString(market as Hex, { size: 32 }).replace(/\0+$/, "");
  return {
    positionTokenAddress: positionToken.toLowerCase(),
    status: settled ? "settled" : closed ? "closed" : "open",
    lifecycle: settled ? "settled" : closed ? "settling" : closeRequested ? "closing" : "open",
    symbol,
    venueMarket: `${symbol}-USD`,
    venueMarketId: null,
    logoUrl: null,
    fullAssetName: null,
    direction: Number(direction) === 1 ? "short" : "long",
    leverage: Number(leverage),
    nickname,
    listed,
    creator: creator.toLowerCase(),
    lendingPoolAddress: null,
    entryPrice: (Number(entry) / 1e18).toString(),
    openedAt: null,
    closedAt: null,
  };
}

export type HolderState = {
  listed: boolean;
  closed: boolean;
  closeRequested: boolean;
  settled: boolean;
  /** Asset base units `claim()` would pay now: (balance + pendingRedeem) × what's left ÷ supply. 0 unless settled. */
  claimable: bigint;
  /** Shares this wallet has posted as collateral in the position's LendingPool. */
  inCollateral: bigint;
  /** What those collateral shares would claim once withdrawn. 0 unless settled. */
  collateralClaimable: bigint;
  /** The token's decimals, which are the asset's: shares and payouts format with the same. */
  decimals: number;
  balance: bigint;
  totalSupply: bigint;
  pendingDeposit: bigint;
  pendingRedeem: bigint;
  /** unix seconds; 0 when never requested */
  lastDepositRequestAt: number;
  lastRedeemRequestAt: number;
};

/** Everything the position page needs to decide which of List / Close / Redeem / Cancel / Claim to show. */
export async function readHolderState(
  positionToken: Address,
  account: Address,
  lendingPool?: Address | null,
): Promise<HolderState> {
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    publicClient().readContract({ address: positionToken, abi: positionTokenAbi, functionName, args } as never) as Promise<T>;
  const [
    listed,
    closed,
    closeRequested,
    settled,
    balance,
    totalSupply,
    pendingDeposit,
    pendingRedeem,
    lastDeposit,
    lastRedeem,
    inCollateral,
    decimals,
  ] = await Promise.all([
    read<boolean>("listed"),
    read<boolean>("closed"),
    read<boolean>("closeRequested"),
    read<boolean>("settled"),
    read<bigint>("balanceOf", [account]),
    read<bigint>("totalSupply"),
    read<bigint>("pendingDepositRequest", [BigInt(0), account]),
    read<bigint>("pendingRedeemRequest", [BigInt(0), account]),
    read<bigint>("lastDepositRequestAt", [account]),
    read<bigint>("lastRedeemRequestAt", [account]),
    lendingPool
      ? (publicClient().readContract({
          address: lendingPool,
          abi: lendingPoolAbi,
          functionName: "collateralBalance",
          args: [account],
        }) as Promise<bigint>)
      : Promise.resolve(BigInt(0)),
    read<number>("decimals"),
  ]);

  let claimable = BigInt(0);
  let collateralClaimable = BigInt(0);
  if (settled && totalSupply > BigInt(0)) {
    const [settlementAssets, claimedAssets] = await Promise.all([
      read<bigint>("settlementAssets"),
      read<bigint>("claimedAssets"),
    ]);
    const remaining = settlementAssets - claimedAssets;
    claimable = ((balance + pendingRedeem) * remaining) / totalSupply;
    collateralClaimable = (inCollateral * remaining) / totalSupply;
  }

  return {
    listed,
    closed,
    closeRequested,
    settled,
    claimable,
    inCollateral,
    collateralClaimable,
    decimals,
    balance,
    totalSupply,
    pendingDeposit,
    pendingRedeem,
    lastDepositRequestAt: Number(lastDeposit),
    lastRedeemRequestAt: Number(lastRedeem),
  };
}

// --- lending pool -----------------------------------------------------------

export type LendingState = {
  /** Position-token shares this wallet has posted. */
  collateralShares: bigint;
  /** Their live value, asset base units. */
  collateralValue: bigint;
  debt: bigint;
  /** What the pool will lend right now, against posted collateral only. */
  available: bigint;
  /**
   * What the pool would lend once the wallet's tokens are posted too:
   * convertToAssets(wallet + posted) × LTV − debt, floored at zero.
   */
  borrowCapacity: bigint;
  /**
   * `!isPriceFresh()` on the token: its Perpl mark or funding update is too
   * old, so borrow and withdraw would revert. Never true once the position is closed.
   */
  oracleStale: boolean;
  /** WAD; null with no debt (the contract returns uint256 max). */
  healthFactor: bigint | null;
  ltvBps: bigint;
  liquidationThresholdBps: bigint;
  /** Position tokens still in the wallet. */
  walletShares: bigint;
  /** Their live value, asset base units. */
  walletValue: bigint;
  /** The wallet's balance of the asset, for repays. */
  walletAsset: bigint;
  /** The position token's decimals, which are the asset's: shares and dollars format alike. */
  decimals: number;
};

/** LendingPool.WAD */
export const WAD = BigInt(10) ** BigInt(18);
const BPS = BigInt(10_000);
const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);

/** Everything the lending panel shows for `account`, read in one round. */
export async function readLendingState(pool: Address, positionToken: Address, account: Address): Promise<LendingState> {
  const client = publicClient();
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: pool, abi: lendingPoolAbi, functionName, args } as never) as Promise<T>;
  const readToken = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: positionToken, abi: positionTokenAbi, functionName, args } as never) as Promise<T>;
  const [
    collateralShares,
    collateralValue,
    debt,
    available,
    healthFactor,
    ltvBps,
    liquidationThresholdBps,
    walletShares,
    walletAsset,
    decimals,
    closed,
    priceFresh,
  ] = await Promise.all([
      read<bigint>("collateralBalance", [account]),
      read<bigint>("collateralValue", [account]),
      read<bigint>("currentDebt", [account]),
      read<bigint>("availableToBorrow", [account]),
      read<bigint>("healthFactor", [account]),
      read<bigint>("ltvBps"),
      read<bigint>("liquidationThresholdBps"),
      client.readContract({ address: positionToken, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      client.readContract({ address: assetAddr(), abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      client.readContract({ address: positionToken, abi: erc20Abi, functionName: "decimals" }),
      readToken<boolean>("closed"),
      // The token's own freshness rule (mark and funding age against the chain's clock).
      readToken<boolean>("isPriceFresh"),
    ]);
  const [combinedValue, walletValue] =
    walletShares === BigInt(0)
      ? [collateralValue, BigInt(0)]
      : await Promise.all([
          readToken<bigint>("convertToAssets", [walletShares + collateralShares]),
          readToken<bigint>("convertToAssets", [walletShares]),
        ]);
  const cap = (combinedValue * ltvBps) / BPS;
  return {
    collateralShares,
    collateralValue,
    debt,
    available,
    borrowCapacity: cap > debt ? cap - debt : BigInt(0),
    oracleStale: !closed && !priceFresh,
    healthFactor: debt === BigInt(0) || healthFactor === MAX_UINT256 ? null : healthFactor,
    ltvBps,
    liquidationThresholdBps,
    walletShares,
    walletValue,
    walletAsset,
    decimals,
  };
}

/**
 * Dry-run a pool call first, so a doomed transaction fails with its revert
 * reason ("LendingPool: exceeds LTV") instead of a wallet prompt and a vague
 * gas-estimation error.
 */
async function simulatePool(
  wallet: LaxuWalletClient,
  pool: Address,
  functionName: "depositCollateral" | "withdrawCollateral" | "borrow" | "repay",
  amount: bigint,
): Promise<void> {
  await publicClient().simulateContract({
    account: wallet.account.address,
    address: pool,
    abi: lendingPoolAbi,
    functionName,
    args: [amount],
  });
}

/** Post position tokens as collateral: approve the pool for the shares, then deposit. */
export async function postCollateral(
  wallet: LaxuWalletClient,
  positionToken: Address,
  pool: Address,
  shares: bigint,
): Promise<Hash> {
  await approveIfNeeded(wallet, positionToken, pool, shares);
  await simulatePool(wallet, pool, "depositCollateral", shares);
  return confirm(
    await wallet.writeContract({ address: pool, abi: lendingPoolAbi, functionName: "depositCollateral", args: [shares] }),
  );
}

export type BorrowStep = "approve" | "deposit" | "borrow";

/**
 * Borrow in one go: post `shares` from the wallet (approving the pool first if
 * its allowance falls short), then borrow `amount`. `onStep` fires as each step
 * starts; a skipped approval never fires. With `shares` of zero it is a plain
 * borrow. A failure after the deposit leaves the tokens posted — the caller
 * should say so.
 */
export async function depositAndBorrow(
  wallet: LaxuWalletClient,
  positionToken: Address,
  pool: Address,
  shares: bigint,
  amount: bigint,
  onStep: (step: BorrowStep) => void,
): Promise<Hash> {
  if (shares > BigInt(0)) {
    const allowance = await publicClient().readContract({
      address: positionToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [wallet.account.address, pool],
    });
    if (allowance < shares) {
      onStep("approve");
      await approveIfNeeded(wallet, positionToken, pool, shares);
    }
    onStep("deposit");
    await simulatePool(wallet, pool, "depositCollateral", shares);
    await confirm(
      await wallet.writeContract({ address: pool, abi: lendingPoolAbi, functionName: "depositCollateral", args: [shares] }),
    );
  }
  onStep("borrow");
  return borrow(wallet, pool, amount);
}

export async function withdrawCollateral(wallet: LaxuWalletClient, pool: Address, shares: bigint): Promise<Hash> {
  await simulatePool(wallet, pool, "withdrawCollateral", shares);
  return confirm(
    await wallet.writeContract({ address: pool, abi: lendingPoolAbi, functionName: "withdrawCollateral", args: [shares] }),
  );
}

export async function borrow(wallet: LaxuWalletClient, pool: Address, amount: bigint): Promise<Hash> {
  await simulatePool(wallet, pool, "borrow", amount);
  return confirm(await wallet.writeContract({ address: pool, abi: lendingPoolAbi, functionName: "borrow", args: [amount] }));
}

/** Over-payment is trimmed on-chain to what's owed, so "repay all" can carry a small buffer. */
export async function repay(wallet: LaxuWalletClient, pool: Address, amount: bigint): Promise<Hash> {
  await approveIfNeeded(wallet, assetAddr(), pool, amount);
  await simulatePool(wallet, pool, "repay", amount);
  return confirm(await wallet.writeContract({ address: pool, abi: lendingPoolAbi, functionName: "repay", args: [amount] }));
}

// --- lending vault ----------------------------------------------------------

export async function lend(wallet: LaxuWalletClient, vault: Address, assets: bigint): Promise<Hash> {
  await approveIfNeeded(wallet, assetAddr(), vault, assets);
  return confirm(
    await wallet.writeContract({
      address: vault,
      abi: lendingVaultAbi,
      functionName: "deposit",
      args: [assets, wallet.account.address],
    }),
  );
}

export async function withdrawLend(wallet: LaxuWalletClient, vault: Address, assets: bigint): Promise<Hash> {
  const me = wallet.account.address;
  return confirm(
    await wallet.writeContract({ address: vault, abi: lendingVaultAbi, functionName: "withdraw", args: [assets, me, me] }),
  );
}
