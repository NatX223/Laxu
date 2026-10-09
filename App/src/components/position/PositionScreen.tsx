"use client";

import { useCallback, useEffect, useState } from "react";
import { parseUnits, type Address } from "viem";
import { BUY_IN_FEE_BPS, buyIn, readPositionFromChain } from "@/lib/actions";
import { getPositionStats, getPublicPosition, getTopHolders, type PositionStats, type PublicPosition, type TopHolder } from "@/lib/api";
import { getAsset, useAsset } from "@/lib/asset";
import { useWalletBalances } from "@/lib/balances";
import { colorFromString, marketFor, useMarkets } from "@/lib/markets";
import { useSession } from "@/lib/session";
import { getWalletClient } from "@/lib/walletClient";
import { Grain } from "../landing/shared";
import TradingViewCredit from "../charts/TradingViewCredit";
import TopNav from "../community/TopNav";
import BuyPanel, { type LiveBuy } from "./BuyPanel";
import HolderActions from "./HolderActions";
import HolderBase from "./HolderBase";
import LendingPanel from "./LendingPanel";
import LeverageView from "./LeverageView";
import PositionHeader from "./PositionHeader";
import ProtectionCard from "./ProtectionCard";
import Reactions from "./Reactions";
import StateGrid from "./StateGrid";
import TriggersPanel from "./TriggersPanel";
import FillsCard from "./FillsCard";
import FundingCard from "./FundingCard";
import VerifiedCard from "./VerifiedCard";
import { usd } from "./data";
import { usePositionEngine, type PositionProps } from "./engine";
import { liveVals, minBuyIn, useTokenState } from "./onchain";

/**
 * A single position token, transcribed from `Laxu Position.dc.html`.
 * Identity band, then the state grid and the two-chart leverage view over a
 * sticky buy-in ticket.
 *
 * `nickname`, `status`, `side`, `leverage`, `creatorFeeBps` and
 * `collateralized` are the knobs the prototype exposed. With a
 * `positionTokenAddress`, the minted position's own side, leverage, nickname
 * and status override them, both charts go live, and the buy-in ticket signs a
 * real `requestDeposit`. The ticket only shows once the creator has listed the
 * position; HolderActions carries List / Close / Redeem / Cancel.
 *
 * A minted position's header and state grid are read off the token itself.
 * Unlisted — reached from the trade page, not the community — it is the
 * creator's alone: no nickname, one holder, no buy-in figures, and no
 * reactions or holder base.
 */
export default function PositionScreen({
  positionTokenAddress,
  ...props
}: PositionProps & { positionTokenAddress?: string }) {
  const { live, failed: positionFailed } = usePublicPosition(positionTokenAddress);
  // Bumped after a buy-in so HolderActions re-reads the pending request at once.
  const [refreshKey, setRefreshKey] = useState(0);
  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  // Keys the wallet's own panels: a sign-out or account switch remounts them,
  // so nothing read for the previous wallet stays on screen.
  const viewer = useSession().wallet?.address;
  const account = viewer ?? "signed-out";
  const chain = useTokenState(live?.positionTokenAddress);
  const { stats: indexed, holders } = useIndexedStats(live?.positionTokenAddress, live?.listed ?? false);
  // The smallest buy-in Perpl can fill: it must add at least one lot of the underlying.
  useMarkets();
  const { symbol } = useAsset();
  const walletBalances = useWalletBalances(viewer);
  const buyerIsCreator = Boolean(viewer && live && viewer.toLowerCase() === live.creator.toLowerCase());
  const feeFraction = buyerIsCreator ? 0 : BUY_IN_FEE_BPS / 10_000;
  const minBuy = live ? minBuyIn(chain, marketFor(live.symbol)?.sizeDecimals, feeFraction) : null;
  const onBuy = useBuyIn(live, bumpRefresh, minBuy, symbol);
  const unlisted = live !== null && !live.listed;
  // The header's "Collateralized" chip: only when this wallet has tokens posted.
  const [collateral, setCollateral] = useState<{ account: string; posted: boolean } | null>(null);
  const onCollateralChange = useCallback((posted: boolean) => setCollateral({ account, posted }), [account]);
  const collateralized = collateral?.account === account && collateral.posted;

  const engine = usePositionEngine({
    ...props,
    ...(live && {
      nickname: live.nickname || undefined,
      symbol: live.symbol || undefined,
      side: live.direction,
      leverage: live.leverage,
      status: live.status === "open" ? "Open" : "Closed",
      collateralized,
      creatorFeeBps: BUY_IN_FEE_BPS,
      onBuy,
    }),
  });
  const { st } = engine;

  // The buy-in ticket for a minted position: the wallet's real balance and a quote worked from the token's own NAV.
  const liveBuy: LiveBuy | undefined = (() => {
    if (!live || !chain) return undefined;
    const amount = parseFloat(String(engine.vals.amount).replace(/[^0-9.]/g, "")) || 0;
    const fee = amount * feeFraction;
    const net = amount - fee;
    const tokens = chain.navPerToken > 0 ? net / chain.navPerToken : 0;
    const share = chain.supply + tokens > 0 ? (tokens / (chain.supply + tokens)) * 100 : 0;
    const max = walletBalances.asset === null ? null : Math.floor(walletBalances.asset * 100) / 100;
    return {
      balance: walletBalances.asset === null ? "—" : usd(walletBalances.asset),
      quick: [
        ...[25, 50, 100].map((n) => ({ label: "$" + n, value: String(n) })),
        { label: "MAX", value: max === null ? "" : String(max) },
      ],
      quote: [
        { k: `Creator fee (${(feeFraction * 100).toFixed(2)}%)`, v: "−" + usd(fee), c: "#ffb765" },
        { k: "Net into position", v: usd(net), c: "#fdfbf7" },
        { k: "Your share of position", v: share.toFixed(2) + "%", c: "#5fe3a8" },
        { k: "Tokens received (est.)", v: tokens.toFixed(2) + " " + chain.ticker, c: "#d5c6ff" },
      ],
      minBuyIn: minBuy,
    };
  })();

  const vals = (() => {
    if (!live) return engine.vals;
    const { isCreator, stats, ...header } = liveVals(live, chain, viewer);
    const rest = unlisted
      ? [
          {
            k: "HOLDERS",
            v: "1",
            c: "#fdfbf7",
            sub: isCreator ? "just you, until you list it" : "the creator, until it's listed",
          },
        ]
      : indexed
        ? [
            {
              k: "HOLDERS",
              v: String(indexed.holderCount),
              c: "#fdfbf7",
              sub: indexed.holderCount === 1 ? "just the creator so far" : "wallets holding or borrowing against it",
            },
            { k: "BUY-IN VOLUME", v: usd(Number(indexed.buyInVolume)), c: "#fdfbf7", sub: "lifetime, all buyers" },
            { k: "CREATOR FEE", v: `${indexed.buyInFeePct}%`, c: "#d5c6ff", sub: "on every buy-in" },
          ]
        : [];
    // The holder base is the backend's real top holders; the prototype's sample handles stay out of a minted page.
    const holdersList = holders.map((h) => ({
      name: h.tag ? `@${h.tag}` : `${h.address.slice(0, 6)}…${h.address.slice(-4)}`,
      tint: colorFromString(h.address),
      share: `${h.sharePct}%`,
    }));
    return { ...engine.vals, ...header, holdersList, stats: [...stats, ...rest] };
  })();

  // A real token never shows the design's sample position: until it has loaded (or when neither the backend nor the chain answers) say so.
  if (positionTokenAddress && !live) {
    return (
      <div className="laxu-position-root" style={{ position: "relative", minHeight: "100vh", background: "#1c1638", color: "#fdfbf7" }}>
        <TopNav communityHref="/community" />
        <div role="status" style={{ padding: "80px 24px", textAlign: "center", fontSize: 14, fontWeight: 600, color: "#a79bd0" }}>
          {positionFailed ? "Couldn\u2019t load this position. Check your connection and try again." : "Loading position\u2026"}
        </div>
      </div>
    );
  }

  return (
    <div
      className="laxu-position-root"
      style={{ position: "relative", minHeight: "100vh", background: "#1c1638", color: "#fdfbf7" }}
    >
      {/* one element, as in the design: z-index 8, 22% opacity, overlay blend */}
      <Grain zIndex={8} />

      <TopNav communityHref="/community" />
      <PositionHeader vals={vals} back={unlisted ? { href: "/trade", label: "Trade" } : undefined} />

      <div
        className="laxu-position-main"
        style={{
          position: "relative",
          zIndex: 2,
          maxWidth: 1280,
          margin: "0 auto",
          padding: "26px clamp(16px, 4vw, 28px) 70px",
          display: "grid",
          gap: 20,
          gridTemplateColumns: "minmax(0, 1fr) 340px",
          alignItems: "start",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
          <StateGrid vals={vals} />
          {live && <VerifiedCard live={live} chain={chain} />}
          {live && <FillsCard token={live.positionTokenAddress} base={live.symbol ?? ""} refreshKey={refreshKey} />}
          {live?.symbol && live.lifecycle === "open" && <FundingCard symbol={live.symbol} direction={live.direction} />}
          <LeverageView
            engine={engine}
            live={live}
            awaitingLive={Boolean(positionTokenAddress) && !live}
            previewSide={props.side}
          />
          {!unlisted && <Reactions engine={engine} />}
          <TradingViewCredit />
        </div>

        <div className="laxu-position-side" style={{ display: "flex", flexDirection: "column", gap: 16, position: "sticky", top: 18 }}>
          {live && <HolderActions key={`actions-${account}`} live={live} refreshKey={refreshKey} onDone={engine.flash} />}
          {live && (
            <LendingPanel
              key={`lending-${account}`}
              live={live}
              refreshKey={refreshKey}
              onDone={engine.flash}
              onCollateralChange={onCollateralChange}
            />
          )}
          {live && <ProtectionCard key={`protection-${account}`} live={live} refreshKey={refreshKey} onDone={engine.flash} />}
          {live && <TriggersPanel key={`triggers-${account}`} live={live} refreshKey={refreshKey} onDone={engine.flash} />}
          {/* Buy-ins open only once the creator lists the position, and close with it. */}
          {(!live || (live.listed && live.lifecycle === "open")) && <BuyPanel engine={engine} liveBuy={liveBuy} />}
          {!unlisted && <HolderBase holders={vals.holdersList} />}
        </div>
      </div>

      {st.toast && (
        <div
          className="laxu-toast"
          role="status"
          style={{
            position: "fixed",
            zIndex: 40,
            left: "50%",
            // clears the fixed testnet banner
            bottom: "calc(var(--laxu-testnet-banner-h, 30px) + 16px)",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 20px",
            borderRadius: 99,
            background: "rgba(36,28,70,0.92)",
            border: "1px solid rgba(255,255,255,0.18)",
            backdropFilter: "blur(18px)",
            boxShadow: "0 18px 40px rgba(10,6,28,0.5)",
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#5fe3a8" }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "#fdfbf7" }}>{st.toast}</span>
        </div>
      )}
    </div>
  );
}

/** Holder count, buy-in volume and the top holders, from the backend's index; refreshed every 30s once a position is listed. */
function useIndexedStats(token: string | undefined, listed: boolean): { stats: PositionStats | null; holders: TopHolder[] } {
  const [state, setState] = useState<{ token: string; stats: PositionStats | null; holders: TopHolder[] } | null>(null);
  useEffect(() => {
    if (!token || !listed) return;
    let cancelled = false;
    const load = () =>
      Promise.all([getPositionStats(token), getTopHolders(token)])
        .then(([stats, top]) => {
          if (!cancelled) setState({ token, stats, holders: top.holders });
        })
        .catch((error) => console.error("could not load position stats", error));
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token, listed]);
  return state && state.token === token ? { stats: state.stats, holders: state.holders } : { stats: null, holders: [] };
}

/** While the backend is still creating the LendingPool, re-read until its address appears. */
const POOL_POLL_MS = 5000;

/** The last backend answer per token, kept in this browser only so the page survives the backend going away. */
const cacheKey = (token: string) => `laxu:position:${token.toLowerCase()}`;

function readCached(token: string): PublicPosition | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(token));
    return raw ? (JSON.parse(raw) as PublicPosition) : null;
  } catch {
    return null;
  }
}

function writeCached(token: string, position: PublicPosition): void {
  try {
    window.localStorage.setItem(cacheKey(token), JSON.stringify(position));
  } catch {
    // private mode: the page just won't survive a backend outage on the next visit
  }
}

/**
 * The position's identity, from the backend. If the backend can't be reached
 * the page keeps working from the chain: the token's own fields, with what
 * only the index knows (lending pool, logo, timestamps) taken from the last
 * copy this browser saw. The mark, NAV, badge and holder actions are on-chain
 * reads either way. `failed`: neither the backend nor the chain answered.
 */
function usePublicPosition(positionTokenAddress: string | undefined): { live: PublicPosition | null; failed: boolean } {
  const [state, setState] = useState<{ token: string; live: PublicPosition | null; failed: boolean } | null>(null);
  const live = state && state.token === positionTokenAddress ? state.live : null;
  const poolPending = live !== null && !live.lendingPoolAddress;
  useEffect(() => {
    if (!positionTokenAddress) return;
    let cancelled = false;
    const done = (position: PublicPosition | null) => {
      if (!cancelled) setState({ token: positionTokenAddress, live: position, failed: position === null });
    };
    const load = () =>
      getPublicPosition(positionTokenAddress)
        .then((position) => {
          writeCached(positionTokenAddress, position);
          done(position);
        })
        .catch(async (error) => {
          console.error("could not load position from the backend; reading it from the chain", error);
          try {
            const fromChain = await readPositionFromChain(positionTokenAddress as Address);
            const cached = readCached(positionTokenAddress);
            // the chain wins on anything it knows; the cache fills in what only the index had
            done(
              cached
                ? { ...cached, ...fromChain, lendingPoolAddress: cached.lendingPoolAddress, logoUrl: cached.logoUrl, fullAssetName: cached.fullAssetName, venueMarketId: cached.venueMarketId, openedAt: cached.openedAt, closedAt: cached.closedAt, entryPrice: cached.entryPrice ?? fromChain.entryPrice }
                : fromChain,
            );
          } catch (chainError) {
            console.error("could not read the position from the chain either", chainError, (chainError as { details?: string }).details ?? "");
            done(readCached(positionTokenAddress));
          }
        });
    if (!poolPending) void load();
    const id = poolPending ? setInterval(load, POOL_POLL_MS) : null;
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
    };
  }, [positionTokenAddress, poolPending]);
  return { live: positionTokenAddress ? live : null, failed: state?.failed ?? false };
}

/**
 * The ticket's real buy-in: approve the asset (exact amount, skipped when the
 * allowance covers it), then `requestDeposit`. The receipt only means
 * *requested*; the backend settles it on Perpl and the tokens arrive with no
 * claim step.
 */
function useBuyIn(live: PublicPosition | null, onRequested: () => void, minBuy: number | null, symbol: string) {
  const { authenticated, wallet, login } = useSession();
  return useCallback(
    async (amountUsd: number) => {
      if (!live) throw new Error("Position not loaded");
      if (!authenticated || !wallet) {
        login();
        return "Log in to buy in";
      }
      if (minBuy !== null && amountUsd < minBuy) {
        // Perpl can't fill less than one lot, so a smaller buy-in would only sit pending until it's reclaimed.
        return `Minimum buy-in is ${minBuy.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${symbol}`;
      }
      const { decimals } = await getAsset();
      const client = await getWalletClient(wallet);
      await buyIn(client, live.positionTokenAddress as Address, parseUnits(String(amountUsd), decimals));
      onRequested();
      return "Buy-in requested \u2014 settling on Perpl\u2026";
    },
    [live, authenticated, wallet, login, onRequested, minBuy, symbol],
  );
}
