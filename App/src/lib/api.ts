import { getAccessToken } from "@privy-io/react-auth";
import { env } from "./env";

/** The backend's error envelope: `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The envelope's `details`, e.g. `{ nextClaimAt }` on a faucet 429. */
    readonly details?: unknown,
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
    const error = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, error?.code ?? "HTTP_ERROR", error?.message ?? res.statusText, error?.details);
  }
  return body as T;
}

// --- shapes the backend returns --------------------------------------------

export type LaxuUser = { walletAddress: string; tag: string; createdAt: string };

export type NavPoint = { time: number; navPerToken: string };
export type NavHistory = { entry: NavPoint; points: NavPoint[]; closed: boolean };

/** Open → Closing (unwinding on Perpl) → Settling (returning funds) → Settled (holders claim). */
export type Lifecycle = "open" | "closing" | "settling" | "settled";

export type PublicPosition = {
  positionTokenAddress: string;
  status: "open" | "closed" | "settled";
  lifecycle: Lifecycle;
  symbol: string | null;
  /** Perpl market name, e.g. "ETH-USD". */
  venueMarket: string | null;
  /** Perpl's API market id — what its candles, book and trades endpoints take. */
  venueMarketId: number | null;
  /** Null when Perpl has no logo — MarketIcon draws a letter avatar. */
  logoUrl: string | null;
  fullAssetName: string | null;
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

/** The slice of `GET /positions/:address` the page's listed-position cells read. */
/** One fill of the position on Perpl, from Perpl's own history API. Amounts are human decimal strings. */
export type VenueFill = {
  fillId: string;
  /** ISO time of the block. */
  time: string | null;
  side: "buy" | "sell";
  action: "open" | "close";
  sizeHuman: string;
  priceHuman: string | null;
  /** Gross fee in the collateral asset (includes any builder fee); negative = rebate. */
  feeHuman: string;
  /** Builder-fee portion of `feeHuman`; only when non-zero. */
  builderFeeHuman?: string;
  liquiditySide: "maker" | "taker" | "unknown";
  orderId: string;
  /** 0x hash; absent when Perpl gave none. */
  txHash?: string;
  blockNumber?: number;
};

export type VenueFills = {
  source: "perpl";
  accountId: string | null;
  market: string | null;
  matchedBy: "order-ids" | "time-window" | null;
  /** Newest first. */
  fills: VenueFill[];
  /** Funding realised on Perpl so far, collateral asset, positive = received. */
  realisedFunding: string | null;
  fetchedAt: string;
  truncated: boolean;
  /** Served from the backend's cache because Perpl was rate limiting. */
  stale?: boolean;
};

export const getVenueFills = (token: string) => apiFetch<VenueFills>(`/positions/${token}/venue-fills`);

/** One funding interval. `ratePct` is percent per interval; positive: longs pay shorts. */
export type FundingPoint = {
  time: number;
  block: number;
  rateMicros: number;
  ratePct: number;
  annualizedPct: number;
  indexPrice: number;
  /** Applies in the future: Perpl's time is an estimate. */
  estimatedTime: boolean;
};

export type FundingSummary = {
  market: string;
  venueMarketId: number;
  intervalSec: number;
  current: (FundingPoint & { whoPays: "longs pay shorts" | "shorts pay longs" | "no funding" }) | null;
  history: FundingPoint[];
  convention: string;
  fetchedAt: string;
};

export const getFunding = (symbol: string, hours = 24) =>
  apiFetch<FundingSummary>(`/markets/${encodeURIComponent(symbol)}/funding?hours=${hours}`);

export type PositionStats = {
  holderCount: number;
  /** All-time bought in, 2dp, in the collateral asset. */
  buyInVolume: string;
  /** The buy-in fee in percent, e.g. "2". */
  buyInFeePct: string;
};

export const getPositionStats = (token: string) => apiFetch<PositionStats>(`/positions/${token}`);

export type TopHolder = {
  address: string;
  tag: string | null;
  /** Token units, human decimal. */
  shares: string;
  /** Percent of supply, 2dp. */
  sharePct: string;
  /** In the collateral asset, 2dp. */
  value: string;
};

/** Top holders of a position token, collateral posted to its pool included. */
export const getTopHolders = (token: string) => apiFetch<{ holders: TopHolder[] }>(`/positions/${token}/holders`);

/** One listed position in discovery (`GET /positions`). Values are human decimal strings. */
export type DiscoveryCard = {
  /** The position token's address, lowercase. */
  address: string;
  name: string;
  nickname: string;
  market: {
    displaySymbol: string;
    baseAsset: string;
    logoUrl: string | null;
    assetClass: "CRYPTO" | "EQUITIES" | "COMMODITIES" | "INDICES" | null;
  };
  direction: "long" | "short";
  leverage: number;
  effectiveLeverage: string;
  entryPrice: string | null;
  markPrice: string | null;
  /** Base-asset size. */
  size: string | null;
  navPerShare: string;
  /** Since entry, percent with 2 decimals, e.g. "48.00". */
  pnlPct: string;
  status: "open" | "closed";
  isAtRisk: boolean;
  isCollateralized: boolean;
  holderCount: number;
  /** All-time collateral bought in, 2dp. */
  buyInVolume: string;
  buyInFeePct: string;
  hasDefaultTriggers: boolean;
  creator: { address: string; tag: string };
  createdAt: string;
};

/** Listed positions only, sorted by the backend (`newest` by default here), up to 100. */
export const getListedPositions = (params: { status?: "open" | "at_risk" | "closed"; limit?: number } = {}) => {
  const query = new URLSearchParams({ sort: "newest", limit: String(params.limit ?? 100) });
  if (params.status) query.set("status", params.status);
  return apiFetch<{ positions: DiscoveryCard[]; nextCursor: string | null }>(`/positions?${query}`);
};

/** Over listed positions; the backend caches it for 60s. USD values are 2dp strings. */
export type GlobalStats = {
  totalValueTokenized: string;
  openPositions: number;
  totalBuyInVolume: string;
  uniqueCreators: number;
};

export const getGlobalStats = () => apiFetch<GlobalStats>("/stats");

/** One token a wallet holds: wallet balance plus shares posted as loan collateral. */
export type PortfolioHolding = {
  position: DiscoveryCard;
  /** Token units, human decimal. */
  shares: string;
  /** shares × NAV, 2dp. */
  value: string;
  /** Bought in (fees included) minus redeemed, 2dp. Tokens received by transfer carry no cost basis. */
  netDeposited: string;
  pnl: string;
  /** Of `shares`, how many sit in a LendingPool. */
  inCollateral: string;
  /** Settled, but some shares are in a loan: repay it to claim. */
  repayToClaim: boolean;
};

/** A buy-in or redeem request still settling on Perpl. */
export type PortfolioPending = {
  /** Position token address. */
  position: string;
  type: "buy_in" | "redeem";
  /** The collateral asset for a buy-in, token units for a redeem. */
  amount: string;
  requestedAt: string;
  cancellableAt: string;
};

export type Portfolio = {
  /** Positions this wallet minted, held or not. */
  created: DiscoveryCard[];
  /** Every token this wallet holds, minted or bought into. */
  holdings: PortfolioHolding[];
  pending: PortfolioPending[];
};

export const getPortfolio = (address: string) => apiFetch<Portfolio>(`/users/${address}/portfolio`);

/** A holder's effective stop loss / take profit. Prices are human decimals; null = none. */
export type HolderTriggers = {
  stopLoss: string | null;
  takeProfit: string | null;
  /** True when these are the creator's defaults (or none because they're retired). */
  usingDefault: boolean;
  defaultsActive: boolean;
  defaultStopLoss: string | null;
  defaultTakeProfit: string | null;
  /** The token's stored mark — a level already crossed here is rejected on-chain. */
  markPrice: string | null;
  /** Estimate only: Perpl publishes no per-position liquidation price. */
  estLiquidationPrice: string | null;
};

/** Works with no balance yet, so a buyer can set theirs before the buy-in settles. */
export const getHolderTriggers = (token: string, holder: string) =>
  apiFetch<HolderTriggers>(`/positions/${token}/triggers/${holder}`);

export type TriggerExit = {
  id: string;
  position: { address: string; name: string; nickname: string };
  kind: "stop_loss" | "take_profit";
  /** Collateral paid out, 2dp. */
  assets: string;
  shares: string;
  txHash: string;
  executedAt: string;
};

/** SL/TP exits for `address` from the last week, newest first. */
export const getTriggerExits = (address: string) =>
  apiFetch<{ triggerExits: TriggerExit[] }>(`/users/${address}/trigger-exits`);

/** The asset already paid to `holder` out of a settled position, human decimal. */
export const getClaimed = (token: string, holder: string) =>
  apiFetch<{ assets: string }>(`/positions/token/${token}/claims/${holder}`);

// --- test funds faucet (testnet only) ---------------------------------------

/**
 * Public: whether to offer test funds at all, even to a signed-out visitor.
 * `assetAmount` is what a claim is expected to pay. The backend's external
 * faucet and its fallback transfer pay different amounts, so the UI never
 * quotes it as a promise; it reports what actually arrived.
 */
export type FaucetConfig = { enabled: boolean; assetAmount: string | null };

export type FaucetStatus = {
  enabled: true;
  canClaim: boolean;
  /** ISO time the cooldown (or the per-IP limit) ends; null when `canClaim`. */
  nextClaimAt: string | null;
  /** Human amount a claim is expected to pay, e.g. "1000". */
  assetAmount: string;
  /** The user's live on-chain balances, human decimals. */
  balances: { asset: string; native: string };
  /** The faucet itself is below its gas reserve: claims send the asset only. */
  faucetLow: boolean;
};

export type FaucetClaimResult = {
  assetTxHash: string;
  nativeTxHash: string | null;
  /** The faucet was too low on MON to top the user up; the asset still went out. */
  nativeSkipped: boolean;
  nextClaimAt: string;
  /** Not sent by the backend today. If it ever is, it is what the toast shows. */
  assetAmount?: string;
};

export const getFaucetConfig = () => apiFetch<FaucetConfig>("/faucet/config");
export const getFaucetStatus = () => apiFetch<FaucetStatus>("/faucet/status", { auth: true });
/** No body: the backend always pays the signed-in user's stored wallet. */
export const claimFaucet = () => apiFetch<FaucetClaimResult>("/faucet/claim", { auth: true, method: "POST" });

// --- health / slot pool -----------------------------------------------------

/** Subaccount slots by status. `free` is how many positions can open right now. */
export type SlotStats = { free: number; reserved: number; allocated: number; settling: number; total: number };

/** `slots` is null when the backend couldn't count them (database down). */
/** `laxuFeePct`: the Laxu (Perpl builder) fee on every venue order, percent of notional; 0 = none. */
export const getHealth = () => apiFetch<{ status: string; slots: SlotStats | null; laxuFeePct?: number }>("/health");

// --- the signed-in user's own positions ------------------------------------

export type MyPosition = {
  id: string;
  /** open → closed (unwinding / returning funds) → settled */
  status: "open" | "closed" | "settled";
  symbol: string | null;
  direction: "long" | "short";
  leverage: number;
  nickname: string;
  listed: boolean;
  /** Null only for a row that never minted. */
  positionTokenAddress: string | null;
  /** Null while createPool is still being retried. */
  lendingPoolAddress: string | null;
  /** Collateral base units. */
  requestedAmount: string;
  depositedAmount: string | null;
  /** 1e18 fixed point. */
  entryPrice: string | null;
  /** Base-asset size, 1e6 fixed point. */
  size: string | null;
  liquidated: boolean;
  createdAt: string;
  openedAt: string | null;
  closedAt: string | null;
};

export const getMyPositions = () => apiFetch<{ positions: MyPosition[] }>("/positions/mine", { auth: true });
