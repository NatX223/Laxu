import type { Market, Position, PositionStats, User } from "@prisma/client";
import type { Address } from "viem";

import { lendingPoolAbi } from "../chain/abi";
import { publicClient } from "../chain/clients";
import { pendingRedeem, readSettlement, shareBalanceOf, totalSupply } from "../chain/writes";
import { db } from "../config/db";
import { badRequest, notFound } from "../lib/errors";
import { PRICE_SCALE, fromSize6, toFixedDecimals } from "../lib/units";
import { bytes32ToSymbol, maxLeverage } from "./markets";
import { holderAddresses } from "./positionStats";
import { effectiveLevels, estLiquidationPrice } from "./triggerMath";

/**
 * Read side for the discovery grid, the position page and the portfolio.
 *
 * Every value leaves as a human decimal string, converted once here with
 * lib/units.ts. Metric definitions live in positionStats.ts; this file only
 * filters, sorts and shapes them.
 */

export const BUY_IN_FEE_PCT = "2";
const TOP_PNL_MIN_AGE_MS = 60 * 60_000;
const REQUEST_CANCEL_TIMEOUT_MS = 20 * 60_000;

type Row = Position & { stats: PositionStats | null; user: User };

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const usd = (x: bigint) => toFixedDecimals(x, 6, 2);
const price = (x: bigint) => toFixedDecimals(x, 18, 2);
const nav4 = (x: bigint) => toFixedDecimals(x, 18, 4);
/// pnl in bps -> percent with 2 decimals, e.g. 4800 -> "48.00".
const pct = (bps: number) => toFixedDecimals(BigInt(bps), 2, 2);

function directionLabel(direction: string): string {
  return direction === "short" ? "Short" : "Long";
}

function baseAssetOf(position: Position, market: Market | undefined): string {
  if (market) return market.baseAsset;
  try {
    return bytes32ToSymbol(position.market);
  } catch {
    return "?";
  }
}

export function cardFor(row: Row, market: Market | undefined) {
  const stats = row.stats;
  const base = baseAssetOf(row, market);
  const token = (row.positionTokenAddress ?? "").toLowerCase();
  const nav = stats ? BigInt(stats.navPerShare) : PRICE_SCALE;
  return {
    address: token,
    // The contract's own name() leads with the same structure; the suffix is
    // the token address's first bytes, stable and short.
    name: `Laxu ${base} ${directionLabel(row.direction)} ${row.leverage}x #${token.slice(2, 6)}`,
    nickname: row.nickname,
    market: {
      displaySymbol: market?.displaySymbol ?? `${base}-USD`,
      baseAsset: base,
      logoUrl: market?.logoUrl ?? null,
      assetClass: market?.assetClass ?? null,
    },
    direction: row.direction,
    leverage: row.leverage,
    effectiveLeverage: stats?.effectiveLeverage ?? `${row.leverage}.00`,
    entryPrice: row.entryPrice ? price(BigInt(row.entryPrice)) : null,
    markPrice: stats ? price(BigInt(stats.markPrice)) : row.markPrice ? price(BigInt(row.markPrice)) : null,
    size: row.size ? fromSize6(BigInt(row.size)) : null,
    navPerShare: nav4(nav),
    pnlPct: pct(stats?.pnlBps ?? 0),
    // 'closed' covers settled too; the position page reads `lifecycle`.
    status: row.status === "open" ? "open" : "closed",
    isAtRisk: stats?.isAtRisk ?? false,
    isCollateralized: stats?.isCollateralized ?? false,
    holderCount: stats?.holderCount ?? 1,
    buyInVolume: usd(BigInt(stats?.buyInVolume ?? "0")),
    buyInFeePct: BUY_IN_FEE_PCT,
    // The creator's SL/TP still applies to holders on the defaults: the
    // card's "SL/TP set" badge.
    hasDefaultTriggers: row.status === "open" && row.defaultsActive,
    creator: { address: row.userWalletAddress, tag: row.user.tag },
    createdAt: row.createdAt.toISOString(),
  };
}

export type Card = ReturnType<typeof cardFor>;

async function marketsById(): Promise<Map<string, Market>> {
  return new Map((await db.market.findMany()).map((m) => [m.id.toLowerCase(), m]));
}

// ---------------------------------------------------------------------------
// Sorting + keyset pagination (pure)
// ---------------------------------------------------------------------------

export type SortKey = "trending" | "pnl" | "holders" | "newest";

export interface Sortable {
  id: string;
  /// Compared left to right, all descending.
  keys: bigint[];
}

export function sortKeysFor(sort: SortKey, row: Pick<Row, "createdAt"> & { stats: PositionStats | null }): bigint[] {
  const s = row.stats;
  switch (sort) {
    case "trending":
      return [BigInt(s?.buyInVolume24h ?? "0"), BigInt(s?.buyerCount24h ?? 0)];
    case "pnl":
      return [BigInt(s?.pnlBps ?? 0)];
    case "holders":
      return [BigInt(s?.holderCount ?? 0)];
    case "newest":
      return [BigInt(row.createdAt.getTime())];
  }
}

/// Descending on every key, then id ascending as the tie-break -- a total order,
/// which is what makes the cursor exact.
export function compareSortable(a: Sortable, b: Sortable): number {
  for (let i = 0; i < Math.max(a.keys.length, b.keys.length); i += 1) {
    const x = a.keys[i] ?? 0n;
    const y = b.keys[i] ?? 0n;
    if (x !== y) return x > y ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function encodeCursor(item: Sortable): string {
  return Buffer.from(JSON.stringify({ k: item.keys.map(String), id: item.id })).toString("base64url");
}

export function decodeCursor(cursor: string): Sortable {
  try {
    const raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { k: string[]; id: string };
    if (!Array.isArray(raw.k) || typeof raw.id !== "string") throw new Error("shape");
    return { id: raw.id, keys: raw.k.map((k) => BigInt(k)) };
  } catch {
    throw badRequest("Invalid cursor", "INVALID_CURSOR");
  }
}

/// One page strictly after `cursor` in sort order, and the cursor for the next.
export function paginate<T extends Sortable>(items: T[], limit: number, cursor?: string): { page: T[]; nextCursor: string | null } {
  const sorted = [...items].sort(compareSortable);
  const after = cursor ? decodeCursor(cursor) : undefined;
  const start = after ? sorted.findIndex((item) => compareSortable(item, after) > 0) : 0;
  const from = start === -1 ? sorted.length : start;
  const page = sorted.slice(from, from + limit);
  const more = from + limit < sorted.length;
  return { page, nextCursor: more && page.length > 0 ? encodeCursor(page[page.length - 1]) : null };
}

/// Case-insensitive match across symbol, base asset, nickname, creator address and tag.
export function matchesQuery(
  q: string,
  fields: { displaySymbol?: string; baseAsset: string; nickname: string; creator: string; tag: string },
): boolean {
  const needle = q.trim().toLowerCase().replace(/^@/, "");
  if (!needle) return true;
  return [fields.displaySymbol ?? "", fields.baseAsset, fields.nickname, fields.creator, fields.tag].some((f) =>
    f.toLowerCase().includes(needle),
  );
}

// ---------------------------------------------------------------------------
// GET /positions, /positions/leaderboard, /stats
// ---------------------------------------------------------------------------

export interface DiscoveryQuery {
  assetClass?: "CRYPTO" | "EQUITIES" | "COMMODITIES" | "INDICES";
  status?: "open" | "at_risk" | "closed";
  sort?: SortKey;
  q?: string;
  limit?: number;
  cursor?: string;
}

async function listedRows(): Promise<Row[]> {
  return db.position.findMany({
    where: { listed: true, positionTokenAddress: { not: null } },
    include: { stats: true, user: true },
  });
}

function oldEnoughForPnl(row: Row, now: number): boolean {
  const since = (row.openedAt ?? row.createdAt).getTime();
  return now - since >= TOP_PNL_MIN_AGE_MS;
}

export async function discoverPositions(query: DiscoveryQuery): Promise<{ positions: Card[]; nextCursor: string | null }> {
  const sort = query.sort ?? "trending";
  const limit = Math.min(Math.max(query.limit ?? 24, 1), 100);
  const markets = await marketsById();
  const now = Date.now();

  const rows = (await listedRows()).filter((row) => {
    const market = markets.get(row.market.toLowerCase());
    if (query.assetClass && market?.assetClass !== query.assetClass) return false;
    if (query.status === "closed" && row.status === "open") return false;
    if (query.status === "open" && row.status !== "open") return false;
    if (query.status === "at_risk" && !(row.status === "open" && row.stats?.isAtRisk)) return false;
    // Top PnL %: only positions open >= 1h, so a 2-minute-old +40% doesn't top the board.
    if (sort === "pnl" && !oldEnoughForPnl(row, now)) return false;
    if (query.q) {
      return matchesQuery(query.q, {
        displaySymbol: market?.displaySymbol,
        baseAsset: baseAssetOf(row, market),
        nickname: row.nickname,
        creator: row.userWalletAddress,
        tag: row.user.tag,
      });
    }
    return true;
  });

  const { page, nextCursor } = paginate(
    rows.map((row) => ({ id: row.id, keys: sortKeysFor(sort, row), row })),
    limit,
    query.cursor,
  );
  return { positions: page.map((item) => cardFor(item.row, markets.get(item.row.market.toLowerCase()))), nextCursor };
}

export async function leaderboard(): Promise<{ topPerformers: Card[]; mostBoughtInto: Card[]; newest: Card[] }> {
  const markets = await marketsById();
  const now = Date.now();
  const open = (await listedRows()).filter((row) => row.status === "open");
  const top = (rows: Row[], keys: (row: Row) => bigint[]) =>
    rows
      .map((row) => ({ id: row.id, keys: keys(row), row }))
      .sort(compareSortable)
      .slice(0, 5)
      .map((item) => cardFor(item.row, markets.get(item.row.market.toLowerCase())));

  return {
    topPerformers: top(open.filter((row) => oldEnoughForPnl(row, now)), (row) => sortKeysFor("pnl", row)),
    mostBoughtInto: top(open, (row) => [BigInt(row.stats?.buyInVolume ?? "0")]),
    newest: top(open, (row) => sortKeysFor("newest", row)),
  };
}

let statsCache: { at: number; value: GlobalStats } | undefined;

export interface GlobalStats {
  totalValueTokenized: string;
  openPositions: number;
  totalBuyInVolume: string;
  uniqueCreators: number;
}

/// Over listed positions. Computed on request, cached in memory for 60s.
export async function globalStats(): Promise<GlobalStats> {
  if (statsCache && Date.now() - statsCache.at < 60_000) return statsCache.value;
  const rows = await listedRows();
  let tvl = 0n;
  let volume = 0n;
  let open = 0;
  for (const row of rows) {
    volume += BigInt(row.stats?.buyInVolume ?? "0");
    if (row.status !== "open") continue;
    open += 1;
    tvl += BigInt(row.stats?.totalAssets ?? row.capital ?? row.depositedAmount ?? "0");
  }
  const value = {
    totalValueTokenized: usd(tvl),
    openPositions: open,
    totalBuyInVolume: usd(volume),
    uniqueCreators: new Set(rows.map((row) => row.userWalletAddress.toLowerCase())).size,
  };
  statsCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------------------
// GET /positions/:address and /positions/:address/holders
// ---------------------------------------------------------------------------

async function rowByToken(address: string): Promise<Row> {
  const row = await db.position.findUnique({
    where: { positionTokenAddress: address.toLowerCase() },
    include: { stats: true, user: true },
  });
  if (!row) throw notFound("No position with that token address");
  return row;
}

export type Lifecycle = "open" | "closing" | "settling" | "settled";

/// Open -> Closing (unwinding on Arcus) -> Settling (returning funds) -> Settled.
export function lifecycleOf(status: string, settlementStatus: string | null): Lifecycle {
  if (status === "settled" || settlementStatus === "settled") return "settled";
  if (status === "closed") return "settling";
  if (settlementStatus !== null) return settlementStatus === "closing" ? "closing" : "settling";
  return "open";
}

export async function positionDetail(address: string) {
  const row = await rowByToken(address);
  const [market, settlement] = await Promise.all([
    db.market.findUnique({ where: { id: row.market.toLowerCase() } }),
    db.settlement.findUnique({ where: { positionId: row.id } }),
  ]);
  const closed = row.status !== "open";
  const lifecycle = lifecycleOf(row.status, settlement?.status ?? null);
  const nav = row.stats ? BigInt(row.stats.navPerShare) : PRICE_SCALE;
  return {
    ...cardFor(row, market ?? undefined),
    // Unlisted positions are served here too (the creator's own page).
    listed: row.listed,
    closed,
    lifecycle,
    closedReason: closed || settlement ? (row.liquidated || settlement?.trigger === "liquidation" ? "liquidated" : "user_closed") : null,
    // Until settled this is the contract's formula estimate; after, the USDG
    // actually recovered per share.
    finalNavPerShare: closed ? nav4(nav) : null,
    recoveredAssets: lifecycle === "settled" && settlement?.recoveredAssets ? usd(BigInt(settlement.recoveredAssets)) : null,
    fundingNet: usd(BigInt(row.stats?.fundingNet ?? "0")),
    capital: usd(BigInt(row.capital ?? row.depositedAmount ?? "0")),
    lendingPoolAddress: row.lendingPoolAddress,
    marketMaxLeverage: market ? maxLeverage(market) : null,
    defaultStopLoss: row.defaultStopLoss,
    defaultTakeProfit: row.defaultTakeProfit,
    defaultsActive: row.defaultsActive,
    estLiquidationPrice: closed ? null : liquidationEstimate(row, market?.maintenanceMarginFraction ?? "0"),
  };
}

/// Arcus publishes no liquidation price; this is where equity would meet the
/// maintenance requirement at the current size (triggerMath.ts). The UI warns
/// when a stop loss sits beyond it.
function liquidationEstimate(row: Row, mmf: string): string | null {
  const stats = row.stats;
  if (!stats || !row.size) return null;
  const estimate = estLiquidationPrice({
    side: row.direction === "short" ? "short" : "long",
    value6: BigInt(stats.totalAssets),
    size6: BigInt(row.size),
    mark18: BigInt(stats.markPrice),
    mmf,
  });
  return estimate === null ? null : price(estimate);
}

type TriggerRow = { holder: string; stopLoss: string | null; takeProfit: string | null };

/// A holder's effective levels as the API returns them: human prices or null.
function triggersView(row: TriggerRow | undefined, position: Position) {
  const levels = effectiveLevels(row, position);
  return {
    stopLoss: levels.stopLoss > 0n ? (levels.usingDefault ? position.defaultStopLoss : row?.stopLoss ?? null) : null,
    takeProfit: levels.takeProfit > 0n ? (levels.usingDefault ? position.defaultTakeProfit : row?.takeProfit ?? null) : null,
    usingDefault: levels.usingDefault,
  };
}

/// GET /positions/:address/triggers/:holder -- works with no balance too, so a
/// buyer can see (and set) theirs before their buy-in settles.
export async function holderTriggers(address: string, holder: string) {
  const row = await rowByToken(address);
  const [override, market] = await Promise.all([
    db.holderTrigger.findUnique({
      where: { positionId_holder: { positionId: row.id, holder: holder.toLowerCase() } },
    }),
    db.market.findUnique({ where: { id: row.market.toLowerCase() } }),
  ]);
  const mark = row.stats?.markPrice ?? row.markPrice;
  return {
    ...triggersView(override ?? undefined, row),
    // Whether "Reset to default" means anything.
    defaultsActive: row.defaultsActive,
    defaultStopLoss: row.defaultStopLoss,
    defaultTakeProfit: row.defaultTakeProfit,
    // setTriggers rejects a level already crossed at the token's stored mark.
    markPrice: mark ? price(BigInt(mark)) : null,
    estLiquidationPrice: row.status === "open" ? liquidationEstimate(row, market?.maintenanceMarginFraction ?? "0") : null,
  };
}

interface HolderRow {
  address: string;
  wallet: bigint;
  collateral: bigint;
}

/// Wallet balances plus shares posted as collateral, pools excluded.
async function holdersOf(row: Row): Promise<HolderRow[]> {
  const token = (row.positionTokenAddress as string).toLowerCase();
  const [holdings, pools] = await Promise.all([
    db.holding.findMany({ where: { positionId: row.id } }),
    db.lendingPool.findMany({ where: { positionTokenAddress: token }, include: { borrowers: true } }),
  ]);
  const poolSet = new Set(pools.map((p) => p.poolAddress.toLowerCase()));
  const byAddress = new Map<string, HolderRow>();
  const get = (address: string) => {
    const key = address.toLowerCase();
    const found = byAddress.get(key) ?? { address: key, wallet: 0n, collateral: 0n };
    byAddress.set(key, found);
    return found;
  };
  for (const h of holdings) if (!poolSet.has(h.address.toLowerCase())) get(h.address).wallet += BigInt(h.balance);
  for (const b of pools.flatMap((p) => p.borrowers)) get(b.address).collateral += BigInt(b.collateralShares);
  const counted = holderAddresses(holdings, [...poolSet], pools.flatMap((p) => p.borrowers));
  return [...byAddress.values()].filter((h) => counted.has(h.address));
}

export async function topHolders(address: string, limit: number) {
  const row = await rowByToken(address);
  const nav = row.stats ? BigInt(row.stats.navPerShare) : PRICE_SCALE;
  const supply = BigInt(row.stats?.totalSupply ?? "0");
  const holders = (await holdersOf(row))
    .map((h) => ({ ...h, shares: h.wallet + h.collateral }))
    .sort((a, b) => (a.shares === b.shares ? 0 : a.shares > b.shares ? -1 : 1))
    .slice(0, limit);
  const users = await db.user.findMany({ where: { walletAddress: { in: holders.map((h) => h.address) } } });
  const tags = new Map(users.map((u) => [u.walletAddress.toLowerCase(), u.tag]));
  return {
    holders: holders.map((h) => ({
      address: h.address,
      tag: tags.get(h.address) ?? null,
      shares: fromSize6(h.shares),
      // shares / supply in percent, 2dp
      sharePct: supply > 0n ? toFixedDecimals((h.shares * 10_000n) / supply, 2, 2) : "0.00",
      value: usd((h.shares * nav) / PRICE_SCALE),
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /users/:address/portfolio
// ---------------------------------------------------------------------------

/**
 * Cost basis per (address, position): Σ open/buy_in/top_up (assets + fee) −
 * Σ redeem assets. Plain token transfers between wallets aren't priced, so
 * received tokens carry no cost basis.
 */
export function netDeposited(flows: Array<{ type: string; assets: string; feeAssets: string }>): bigint {
  let net = 0n;
  for (const flow of flows) {
    const gross = BigInt(flow.assets) + BigInt(flow.feeAssets);
    if (flow.type === "redeem" || flow.type === "trigger_exit" || flow.type === "claim") net -= BigInt(flow.assets);
    else if (flow.type === "open" || flow.type === "buy_in" || flow.type === "top_up") net += gross;
  }
  return net;
}

export async function portfolio(rawAddress: string) {
  const address = rawAddress.toLowerCase();
  const markets = await marketsById();
  const card = (row: Row) => cardFor(row, markets.get(row.market.toLowerCase()));

  const [created, holdings, borrowers, flows, pendingEntries, overrides] = await Promise.all([
    db.position.findMany({
      where: { userWalletAddress: { equals: address, mode: "insensitive" }, positionTokenAddress: { not: null } },
      include: { stats: true, user: true },
      orderBy: { createdAt: "desc" },
    }),
    db.holding.findMany({ where: { address } }),
    db.borrower.findMany({ where: { address }, include: { lendingPool: true } }),
    db.flow.findMany({ where: { address } }),
    db.ledgerEntry.findMany({
      where: {
        controller: address,
        type: { in: ["margin_add", "margin_remove"] },
        onchainFulfilledAt: null,
        arcusStatus: { in: ["pending", "confirmed"] },
      },
      include: { position: true },
      orderBy: { createdAt: "asc" },
    }),
    db.holderTrigger.findMany({ where: { holder: address } }),
  ]);

  // Holdings: wallet balance plus collateral, per position.
  const collateralByToken = new Map<string, bigint>();
  for (const b of borrowers) {
    const token = b.lendingPool.positionTokenAddress.toLowerCase();
    collateralByToken.set(token, (collateralByToken.get(token) ?? 0n) + BigInt(b.collateralShares));
  }
  const positionIds = new Set(holdings.filter((h) => BigInt(h.balance) > 0n).map((h) => h.positionId));
  const tokenRows = await db.position.findMany({
    where: {
      OR: [
        { id: { in: [...positionIds] } },
        { positionTokenAddress: { in: [...collateralByToken.keys()] } },
      ],
    },
    include: { stats: true, user: true },
  });

  const holdingRows = tokenRows.map((row) => {
    const token = (row.positionTokenAddress as string).toLowerCase();
    const wallet = BigInt(holdings.find((h) => h.positionId === row.id)?.balance ?? "0");
    const inCollateral = collateralByToken.get(token) ?? 0n;
    const shares = wallet + inCollateral;
    const nav = row.stats ? BigInt(row.stats.navPerShare) : PRICE_SCALE;
    const value = (shares * nav) / PRICE_SCALE;
    const net = netDeposited(flows.filter((f) => f.positionId === row.id));
    return {
      position: card(row),
      shares: fromSize6(shares),
      value: usd(value),
      netDeposited: usd(net),
      pnl: usd(value - net),
      inCollateral: fromSize6(inCollateral),
      // Settled, but some of these shares sit in a LendingPool: "repay your
      // loan to claim".
      repayToClaim: row.status === "settled" && inCollateral > 0n,
      // SL/TP covers the wallet balance only, never the shares in a loan.
      triggers: triggersView(overrides.find((o) => o.positionId === row.id), row),
    };
  });

  const claimable = await claimableFor(address, [
    ...new Set([...positionIds, ...flows.filter((f) => f.type === "redeem").map((f) => f.positionId)]),
    ...pendingEntries.filter((e) => e.type === "margin_remove").map((e) => e.positionId),
  ]);

  // Loans: health factor and headroom read live -- a stale one would mislead.
  const loans = await Promise.all(
    borrowers
      .filter((b) => BigInt(b.debt) > 0n || BigInt(b.collateralShares) > 0n)
      .map(async (b) => {
        const pool = b.lendingPool.poolAddress as Address;
        const row = tokenRows.find(
          (r) => (r.positionTokenAddress ?? "").toLowerCase() === b.lendingPool.positionTokenAddress.toLowerCase(),
        );
        const [healthFactor, available, debt] = await Promise.all(
          (["healthFactor", "availableToBorrow", "currentDebt"] as const).map(
            (functionName) =>
              publicClient().readContract({ address: pool, abi: lendingPoolAbi, functionName, args: [address as Address] }) as Promise<bigint>,
          ),
        );
        return {
          position: row ? card(row) : null,
          pool: pool.toLowerCase(),
          collateralShares: fromSize6(BigInt(b.collateralShares)),
          debt: usd(debt),
          // WAD; with no debt it is effectively infinite.
          healthFactor: debt === 0n ? null : toFixedDecimals(healthFactor, 18, 2),
          availableToBorrow: usd(available),
        };
      }),
  );

  // Pending: requests without a matching fulfil or cancel -- the "Settling on
  // Arcus…" state and the Cancel button. A redeem caught by a close is paid by
  // claim instead; a buy-in caught by one is refundable straight away.
  const pending = pendingEntries
    .filter((e) => e.position.positionTokenAddress && (e.position.status === "open" || e.type === "margin_add"))
    .map((e) => ({
      position: (e.position.positionTokenAddress as string).toLowerCase(),
      type: e.type === "margin_add" ? "buy_in" : "redeem",
      // USDG for a buy-in, shares for a redeem.
      amount: e.type === "margin_add" ? usd(BigInt(e.requestAmount ?? e.amount)) : fromSize6(BigInt(e.requestAmount ?? "0")),
      requestedAt: e.createdAt.toISOString(),
      cancellableAt: (e.position.status === "open"
        ? new Date(e.createdAt.getTime() + REQUEST_CANCEL_TIMEOUT_MS)
        : e.createdAt
      ).toISOString(),
    }));

  // SL/TP exits from the last week, newest first -- the "your stop loss
  // executed" notification. The client remembers which it has shown.
  const triggerExits = await triggerExitsFor(flows, card);

  return {
    created: created.map(card),
    holdings: holdingRows,
    loans,
    pending,
    claimable,
    triggerExits,
  };
}

const TRIGGER_EXIT_WINDOW_MS = 7 * 24 * 60 * 60_000;

/// GET /users/:address/trigger-exits -- the light poll behind the "your stop
/// loss executed" notification (portfolio also carries these, but reads loans live).
export async function recentTriggerExits(rawAddress: string) {
  const address = rawAddress.toLowerCase();
  const [markets, flows] = await Promise.all([
    marketsById(),
    db.flow.findMany({
      where: { address, type: "trigger_exit", timestamp: { gte: new Date(Date.now() - TRIGGER_EXIT_WINDOW_MS) } },
    }),
  ]);
  return { triggerExits: await triggerExitsFor(flows, (row) => cardFor(row, markets.get(row.market.toLowerCase()))) };
}

async function triggerExitsFor(
  flows: Array<{ id: string; positionId: string; type: string; trigger: string | null; assets: string; shares: string; txHash: string; timestamp: Date }>,
  card: (row: Row) => Card,
) {
  const since = Date.now() - TRIGGER_EXIT_WINDOW_MS;
  const exits = flows
    .filter((f) => f.type === "trigger_exit" && f.timestamp.getTime() >= since)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  if (exits.length === 0) return [];
  const rows = await db.position.findMany({
    where: { id: { in: [...new Set(exits.map((f) => f.positionId))] } },
    include: { stats: true, user: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return exits.flatMap((f) => {
    const row = byId.get(f.positionId);
    if (!row) return [];
    return [
      {
        id: f.id,
        position: card(row),
        kind: f.trigger === "take_profit" ? "take_profit" : "stop_loss",
        assets: usd(BigInt(f.assets)),
        shares: fromSize6(BigInt(f.shares)),
        txHash: f.txHash,
        executedAt: f.timestamp.toISOString(),
      },
    ];
  });
}

/**
 * Settled positions where `address` still has something to claim: shares in
 * the wallet, or a redeem caught pending at close. Read live -- the push job
 * may have paid them a moment ago. Shares posted as loan collateral are not
 * claimable until withdrawn (see `repayToClaim` on the holding).
 */
async function claimableFor(address: string, positionIds: string[]) {
  if (positionIds.length === 0) return [];
  const markets = await marketsById();
  const rows = await db.position.findMany({
    where: { id: { in: [...new Set(positionIds)] }, status: "settled", positionTokenAddress: { not: null } },
    include: { stats: true, user: true },
  });
  const holder = address as Address;
  const items = await Promise.all(
    rows.map(async (row) => {
      const token = row.positionTokenAddress as Address;
      const [held, redeeming, state, supply] = await Promise.all([
        shareBalanceOf(token, holder),
        pendingRedeem(token, holder),
        readSettlement(token),
        totalSupply(token),
      ]);
      const shares = held + redeeming;
      if (shares === 0n || supply === 0n) return null;
      return {
        position: cardFor(row, markets.get(row.market.toLowerCase())),
        shares: fromSize6(shares),
        assets: usd((shares * (state.settlementAssets - state.claimedAssets)) / supply),
      };
    }),
  );
  return items.filter((item) => item !== null);
}

