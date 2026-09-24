"use client";

import { useCallback, useEffect, useState } from "react";
import { erc20Abi, parseUnits, type Address } from "viem";
import { buyIn } from "@/lib/actions";
import { getPublicPosition, type PublicPosition } from "@/lib/api";
import { publicClient } from "@/lib/chain";
import { env } from "@/lib/env";
import { useSession } from "@/lib/session";
import { getWalletClient } from "@/lib/walletClient";
import { Grain } from "../landing/shared";
import TradingViewCredit from "../charts/TradingViewCredit";
import TopNav from "../community/TopNav";
import BuyPanel from "./BuyPanel";
import HolderActions from "./HolderActions";
import HolderBase from "./HolderBase";
import LeverageView from "./LeverageView";
import PositionHeader from "./PositionHeader";
import Reactions from "./Reactions";
import StateGrid from "./StateGrid";
import TriggersPanel from "./TriggersPanel";
import { usePositionEngine, type PositionProps } from "./engine";

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
 */
export default function PositionScreen({
  positionTokenAddress,
  ...props
}: PositionProps & { positionTokenAddress?: string }) {
  const live = usePublicPosition(positionTokenAddress);
  // Bumped after a buy-in so HolderActions re-reads the pending request at once.
  const [refreshKey, setRefreshKey] = useState(0);
  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const onBuy = useBuyIn(live, bumpRefresh);

  const engine = usePositionEngine({
    ...props,
    ...(live && {
      nickname: live.nickname || undefined,
      symbol: live.symbol || undefined,
      side: live.direction,
      leverage: live.leverage,
      status: live.status === "open" ? "Open" : "Closed",
      onBuy,
    }),
  });
  const { st, vals } = engine;

  return (
    <div
      className="laxu-position-root"
      style={{ position: "relative", minHeight: "100vh", background: "#1c1638", color: "#fdfbf7" }}
    >
      {/* one element, as in the design: z-index 8, 22% opacity, overlay blend */}
      <Grain zIndex={8} />

      <TopNav communityHref="/community" />
      <PositionHeader vals={vals} />

      <div
        style={{
          position: "relative",
          zIndex: 2,
          maxWidth: 1280,
          margin: "0 auto",
          padding: "26px 28px 70px",
          display: "grid",
          gap: 20,
          gridTemplateColumns: "minmax(0, 1fr) 340px",
          alignItems: "start",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
          <StateGrid vals={vals} />
          <LeverageView
            engine={engine}
            live={live}
            awaitingLive={Boolean(positionTokenAddress) && !live}
            previewSide={props.side}
          />
          <Reactions engine={engine} />
          <TradingViewCredit />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16, position: "sticky", top: 18 }}>
          {live && <HolderActions live={live} refreshKey={refreshKey} onDone={engine.flash} />}
          {live && <TriggersPanel live={live} refreshKey={refreshKey} onDone={engine.flash} />}
          {/* Buy-ins open only once the creator lists the position, and close with it. */}
          {(!live || (live.listed && live.lifecycle === "open")) && <BuyPanel engine={engine} />}
          <HolderBase holders={vals.holdersList} />
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
            bottom: 28,
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

function usePublicPosition(positionTokenAddress: string | undefined): PublicPosition | null {
  const [live, setLive] = useState<PublicPosition | null>(null);
  useEffect(() => {
    if (!positionTokenAddress) return;
    let cancelled = false;
    getPublicPosition(positionTokenAddress)
      .then((position) => {
        if (!cancelled) setLive(position);
      })
      .catch((error) => console.error("could not load position", error));
    return () => {
      cancelled = true;
    };
  }, [positionTokenAddress]);
  return positionTokenAddress ? live : null;
}

/**
 * The ticket's real buy-in: approve USDG (exact amount, skipped when the
 * allowance covers it), then `requestDeposit`. The receipt only means
 * *requested*; the backend settles it on Arcus and the tokens arrive with no
 * claim step.
 */
function useBuyIn(live: PublicPosition | null, onRequested: () => void) {
  const { authenticated, wallet, login } = useSession();
  return useCallback(
    async (amountUsd: number) => {
      if (!live) throw new Error("Position not loaded");
      if (!authenticated || !wallet) {
        login();
        return "Log in to buy in";
      }
      const decimals = await publicClient().readContract({
        address: env.usdgAddress as Address,
        abi: erc20Abi,
        functionName: "decimals",
      });
      const client = await getWalletClient(wallet);
      await buyIn(client, live.positionTokenAddress as Address, parseUnits(String(amountUsd), decimals));
      onRequested();
      return "Buy-in requested \u2014 settling on Arcus\u2026";
    },
    [live, authenticated, wallet, login, onRequested],
  );
}
