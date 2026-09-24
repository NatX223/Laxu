import { erc20Abi, parseUnits, type Address, type Hash } from "viem";
import { apiFetch } from "./api";
import { publicClient } from "./chain";
import { env } from "./env";
import type { LaxuWalletClient } from "./walletClient";

/**
 * Every on-chain action a user signs themselves. The backend never holds or
 * moves a user's funds; it only fulfils the async requests these create.
 *
 * Each helper waits for its receipt before resolving. For the async ones
 * (`requestDeposit` / `requestRedeem` / `requestClose`) a receipt only means
 * *requested* — the UI shows "Settling on Arcus…" until the backend fulfils
 * it. The fulfil mints the tokens (buy-in) or pays the USDG (redeem) straight
 * to the wallet that asked. The one claim step is after a position closes and
 * settles: the backend pushes each holder's payout, and `claim()` is the
 * fallback for anyone it didn't reach.
 */

// --- ABIs: only what's called here ------------------------------------------

const positionTokenAbi = [
  {
    type: "function",
    name: "requestDeposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "controller", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "requestId", type: "uint256" }],
  },
  {
    type: "function",
    name: "requestRedeem",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "controller", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "requestId", type: "uint256" }],
  },
  /** Creator only, holding 100% of supply, no deposit pending — the contract enforces it. */
  { type: "function", name: "requestClose", stateMutability: "nonpayable", inputs: [], outputs: [] },
  /** After settlement: burns the caller's shares (and any redeem caught pending at close) for their USDG. */
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [{ name: "assets", type: "uint256" }] },
  { type: "function", name: "settled", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "settlementAssets", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "claimedAssets", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  /** One-way: opens the position to buy-ins and sets the nickname (≤ 32 bytes, "" for none). */
  {
    type: "function",
    name: "list",
    stateMutability: "nonpayable",
    inputs: [{ name: "_nickname", type: "string" }],
    outputs: [],
  },
  { type: "function", name: "cancelDepositRequest", stateMutability: "nonpayable", inputs: [], outputs: [{ name: "assets", type: "uint256" }] },
  { type: "function", name: "cancelRedeemRequest", stateMutability: "nonpayable", inputs: [], outputs: [{ name: "shares", type: "uint256" }] },
  {
    type: "function",
    name: "pendingDepositRequest",
    stateMutability: "view",
    inputs: [
      { name: "requestId", type: "uint256" },
      { name: "controller", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "pendingRedeemRequest",
    stateMutability: "view",
    inputs: [
      { name: "requestId", type: "uint256" },
      { name: "controller", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  { type: "function", name: "lastDepositRequestAt", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "lastRedeemRequestAt", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "listed", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "closed", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "closeRequested", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  /** Personal SL/TP for the caller's own wallet balance; 0 = none for that side. Prices at 1e18. */
  {
    type: "function",
    name: "setTriggers",
    stateMutability: "nonpayable",
    inputs: [
      { name: "stopLoss", type: "uint256" },
      { name: "takeProfit", type: "uint256" },
    ],
    outputs: [],
  },
  /** Explicitly no triggers — the creator's defaults stop applying to the caller. */
  { type: "function", name: "clearTriggers", stateMutability: "nonpayable", inputs: [], outputs: [] },
  /** Back to the creator's defaults. */
  { type: "function", name: "useDefaultTriggers", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

/** PositionToken.REQUEST_CANCEL_TIMEOUT: an unfulfilled request can be taken back after this. */
export const REQUEST_CANCEL_TIMEOUT_S = 20 * 60;
/** PositionToken.MAX_NICKNAME_LENGTH, in bytes. */
export const MAX_NICKNAME_BYTES = 32;
/** PositionToken.BUY_IN_FEE_BPS — 2%, paid to the creator; the creator pays none on their own position. */
export const BUY_IN_FEE_BPS = 200;

const lendingPoolAbi = [
  { type: "function", name: "depositCollateral", stateMutability: "nonpayable", inputs: [{ name: "shares", type: "uint256" }], outputs: [] },
  { type: "function", name: "withdrawCollateral", stateMutability: "nonpayable", inputs: [{ name: "shares", type: "uint256" }], outputs: [] },
  { type: "function", name: "collateralBalance", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "borrow", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  {
    type: "function",
    name: "repay",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ name: "repaid", type: "uint256" }],
  },
] as const;

/** LendingVault is a plain synchronous ERC-4626. */
const vaultAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
] as const;

// --- plumbing ---------------------------------------------------------------

function usdg(): Address {
  if (!env.usdgAddress) throw new Error("NEXT_PUBLIC_USDG_ADDRESS is not set");
  return env.usdgAddress as Address;
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

// --- open -------------------------------------------------------------------

export type OpenReservation = {
  openRequestId: string;
  /** The reserved slot's internal Arcus wallet — where the USDG goes. */
  payTo: string;
  usdg: string;
  /** USDG base units. */
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
  paymentTxHash: string | null;
  positionTokenAddress: string | null;
  lendingPoolAddress: string | null;
  refundTxHash: string | null;
  error: string | null;
};

/**
 * Open a position: reserve an internal Arcus subaccount, pay its wallet with a
 * plain USDG transfer, then report the transaction. The backend deposits it on
 * Arcus, trades, and mints the token; poll {getOpenRequest} until `minted`
 * (then go to the position page) or `refunded`.
 *
 * `wallet` must be the wallet the backend knows as this user — the payment is
 * checked against it — which is what the session's `wallet` is.
 */
export async function openPosition(
  wallet: LaxuWalletClient,
  request: {
    market: string;
    direction: "long" | "short";
    leverage: number;
    /** human USDG, e.g. "500" */
    amount: string;
    /** The creator's SL/TP as human prices ("1900") — the default for everyone who buys in. */
    stopLoss?: string;
    takeProfit?: string;
  },
): Promise<{ reservation: OpenReservation; hash: Hash }> {
  const reservation = await apiFetch<OpenReservation>("/positions/open", {
    auth: true,
    method: "POST",
    body: JSON.stringify(request),
  });
  const hash = await confirm(
    await wallet.writeContract({
      address: reservation.usdg as Address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [reservation.payTo as Address, BigInt(reservation.amount)],
    }),
  );
  await apiFetch<OpenRequest>(`/positions/open/${reservation.openRequestId}/paid`, {
    auth: true,
    method: "POST",
    body: JSON.stringify({ txHash: hash }),
  });
  return { reservation, hash };
}

export const getOpenRequest = (openRequestId: string) =>
  apiFetch<OpenRequest>(`/positions/open/${openRequestId}`, { auth: true });

// --- position token ---------------------------------------------------------

/**
 * Buy in / add margin: approve USDG to the token, then queue the deposit.
 * Others can only buy into a listed position (2% of the amount goes to the
 * creator); the creator can top up their own position any time, fee-free.
 */
export async function buyIn(wallet: LaxuWalletClient, positionToken: Address, assets: bigint): Promise<Hash> {
  const me = wallet.account.address;
  await approveIfNeeded(wallet, usdg(), positionToken, assets);
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

export type HolderState = {
  listed: boolean;
  closed: boolean;
  closeRequested: boolean;
  settled: boolean;
  /** USDG base units `claim()` would pay now: (balance + pendingRedeem) × what's left ÷ supply. 0 unless settled. */
  claimable: bigint;
  /** Shares this wallet has posted as collateral in the position's LendingPool. */
  inCollateral: bigint;
  /** What those collateral shares would claim once withdrawn. 0 unless settled. */
  collateralClaimable: bigint;
  /** The token's decimals, which are USDG's: shares and payouts format with the same. */
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

/** Post position tokens as collateral: approve the pool for the shares, then deposit. */
export async function postCollateral(
  wallet: LaxuWalletClient,
  positionToken: Address,
  pool: Address,
  shares: bigint,
): Promise<Hash> {
  await approveIfNeeded(wallet, positionToken, pool, shares);
  return confirm(
    await wallet.writeContract({ address: pool, abi: lendingPoolAbi, functionName: "depositCollateral", args: [shares] }),
  );
}

export async function withdrawCollateral(wallet: LaxuWalletClient, pool: Address, shares: bigint): Promise<Hash> {
  return confirm(
    await wallet.writeContract({ address: pool, abi: lendingPoolAbi, functionName: "withdrawCollateral", args: [shares] }),
  );
}

export async function borrow(wallet: LaxuWalletClient, pool: Address, amount: bigint): Promise<Hash> {
  return confirm(await wallet.writeContract({ address: pool, abi: lendingPoolAbi, functionName: "borrow", args: [amount] }));
}

export async function repay(wallet: LaxuWalletClient, pool: Address, amount: bigint): Promise<Hash> {
  await approveIfNeeded(wallet, usdg(), pool, amount);
  return confirm(await wallet.writeContract({ address: pool, abi: lendingPoolAbi, functionName: "repay", args: [amount] }));
}

// --- lending vault ----------------------------------------------------------

export async function lend(wallet: LaxuWalletClient, vault: Address, assets: bigint): Promise<Hash> {
  await approveIfNeeded(wallet, usdg(), vault, assets);
  return confirm(
    await wallet.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "deposit",
      args: [assets, wallet.account.address],
    }),
  );
}

export async function withdrawLend(wallet: LaxuWalletClient, vault: Address, assets: bigint): Promise<Hash> {
  const me = wallet.account.address;
  return confirm(
    await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: "withdraw", args: [assets, me, me] }),
  );
}
