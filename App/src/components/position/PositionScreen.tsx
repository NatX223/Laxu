"use client";

import { useCallback, useEffect, useState } from "react";
import { parseUnits, type Address } from "viem";
import { BUY_IN_FEE_BPS, buyIn } from "@/lib/actions";
import { getPublicPosition, type PublicPosition } from "@/lib/api";
import { getAsset, useAsset } from "@/lib/asset";
import { useWalletBalances } from "@/lib/balances";
import { marketFor, useMarkets } from "@/lib/markets";
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
import Reactions from "./Reactions";
import StateGrid from "./StateGrid";
import TriggersPanel from "./TriggersPanel";
import VerifiedCard from "./VerifiedCard";
import { usd } from "./data";
import { usePositionEngine, type PositionProps } from "./engine";
import { liveVals, minBuyIn, useTokenState } from "./onchain";

/** The listed page's cells the contract can't answer yet; they keep the prototype's figures. */
const LISTED_ONLY = ["HOLDERS", "BUY-IN VOLUME", "CREATOR FEE"];

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
  const live = usePublicPosition(positionTokenAddress);
  // Bumped after a buy-in so HolderActions re-reads the pending request at once.
  const [refreshKey, setRefreshKey] = useState(0);
  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  // Keys the wallet's own panels: a sign-out or account switch remounts them,
  // so nothing read for the previous wallet stays on screen.
  const viewer = useSession().wallet?.address;
  const account = viewer ?? "signed-out";
  const chain = useTokenState(live?.positionTokenAddress);
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
      : engine.vals.stats.filter((s) => LISTED_ONLY.includes(s.k));
    return { ...engine.vals, ...header, stats: [...stats, ...rest] };
  })();

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

/** While the backend is still creating the LendingPool, re-read until its address appears. */
const POOL_POLL_MS = 5000;

function usePublicPosition(positionTokenAddress: string | undefined): PublicPosition | null {
  const [live, setLive] = useState<PublicPosition | null>(null);
  const poolPending = live !== null && !live.lendingPoolAddress;
  useEffect(() => {
    if (!positionTokenAddress) return;
    let cancelled = false;
    const load = () =>
      getPublicPosition(positionTokenAddress)
        .then((position) => {
          if (!cancelled) setLive(position);
        })
        .catch((error) => console.error("could not load position", error));
    if (!poolPending) void load();
    const id = poolPending ? setInterval(load, POOL_POLL_MS) : null;
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
    };
  }, [positionTokenAddress, poolPending]);
  return positionTokenAddress ? live : null;
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
