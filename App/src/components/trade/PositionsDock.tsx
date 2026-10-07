"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import {
  closePosition,
  exitStake,
  readHolderState,
  readLendingState,
  txErrorMessage,
  withdrawCollateral,
} from "@/lib/actions";
import { useAsset } from "@/lib/asset";
import { useSession } from "@/lib/session";
import { getWalletClient } from "@/lib/walletClient";
import { money, type Position } from "./data";
import { liqOf, type TradeEngine } from "./engine";
import { usePositionNavs } from "./navs";
import { Disc, MONO } from "./shared";

const COLS = "minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.05fr) minmax(0, 1.5fr)";
const HEADS = ["MARKET", "SIZE · ENTRY", "MARK · LIQ", "UNREALIZED", "LAXU STATE"];

/** Truncating cell text — every dock column clips rather than wraps. */
const CLIP: React.CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

const CHIP: React.CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: "0.06em",
  padding: "5px 8px",
  borderRadius: 99,
  whiteSpace: "nowrap",
};

/** How long the "Confirm" state waits for the second click before reverting. */
const CONFIRM_MS = 4000;

/**
 * Exit from the dock. Tokens posted as loan collateral are withdrawn from the
 * pool first (only possible with no debt), then, reading the chain afresh:
 *   - the creator holding the whole supply: `requestClose()` -- the backend
 *     closes the Perpl trade and settles the actual proceeds back.
 *   - otherwise: `requestRedeem` of the wallet balance -- the backend reduces
 *     Perpl by that fraction and pays the asset straight to the wallet.
 */
function CloseButton({ position, engine }: { position: Position; engine: TradeEngine }) {
  const { wallet } = useSession();
  const { flash, reloadPositions } = engine.actions;
  const { symbol } = useAsset();
  const [phase, setPhase] = useState<"idle" | "confirm" | "busy" | "withdrawing" | "closing" | "redeeming">("idle");

  useEffect(() => {
    if (phase !== "confirm") return;
    const id = setTimeout(() => setPhase("idle"), CONFIRM_MS);
    return () => clearTimeout(id);
  }, [phase]);

  const run = async () => {
    if (!wallet) return;
    setPhase("busy");
    const token = position.addr as Address;
    const account = wallet.address as Address;
    const pool = position.pool as Address | null;
    try {
      let s = await readHolderState(token, account, pool);
      if (s.closed || s.closeRequested) throw new Error("This position is already closing");
      if (s.pendingRedeem > BigInt(0)) throw new Error("A redeem is already settling on Perpl");
      const client = await getWalletClient(wallet);

      // Bring posted collateral home first, so the whole stake exits in one go.
      if (pool && s.inCollateral > BigInt(0)) {
        const lending = await readLendingState(pool, token, account);
        if (lending.debt > BigInt(0)) throw new Error("Your tokens back a loan. Repay it first, then close.");
        setPhase("withdrawing");
        await withdrawCollateral(client, pool, s.inCollateral);
        setPhase("busy");
        s = await readHolderState(token, account, pool);
      }
      if (s.balance === BigInt(0)) throw new Error("No tokens in your wallet to sell");

      if (s.balance === s.totalSupply) {
        if (s.pendingDeposit > BigInt(0)) throw new Error("A buy-in is still settling; try again in a minute");
        await closePosition(client, token);
        flash("Close requested — closing the trade on Perpl");
        setPhase("closing");
      } else {
        await exitStake(client, token, s.balance);
        flash(`Redeem requested — ${symbol} lands in your wallet once Perpl fills`);
        setPhase("redeeming");
      }
      reloadPositions();
    } catch (error) {
      flash(txErrorMessage(error));
      setPhase("idle");
    }
  };

  if (phase === "closing" || phase === "redeeming") {
    return (
      <div style={{ ...CHIP, background: "rgba(255,255,255,0.08)", color: "#a79bd0" }}>
        {phase === "closing" ? "CLOSING" : "REDEEMING"}
      </div>
    );
  }

  const confirming = phase === "confirm";
  return (
    <button
      type="button"
      disabled={phase === "busy" || phase === "withdrawing" || !wallet}
      onClick={(e) => {
        // The row is a link to the position page; this click is the button's alone.
        e.preventDefault();
        e.stopPropagation();
        if (phase === "idle") setPhase("confirm");
        else if (confirming) void run();
      }}
      style={{
        ...CHIP,
        fontFamily: "inherit",
        cursor: confirming || phase === "idle" ? "pointer" : "default",
        border: `1px solid ${confirming ? "#ff6b57" : "rgba(255,143,125,0.5)"}`,
        background: confirming ? "#ff6b57" : "rgba(255,107,87,0.12)",
        color: confirming ? "#1c1638" : "#ff8f7d",
        opacity: confirming || phase === "idle" ? 1 : 0.6,
      }}
    >
      {phase === "withdrawing"
        ? "WITHDRAWING COLLATERAL…"
        : phase === "busy"
          ? "CONFIRM IN WALLET…"
          : confirming
            ? "CONFIRM CLOSE"
            : "CLOSE"}
    </button>
  );
}

/** The lit panel under the workspace: the user's minted positions, each linking to its page. */
export default function PositionsDock({ engine }: { engine: TradeEngine }) {
  const { st } = engine;
  // PnL is the token's own NAV (currentPnLBps), so funding and fees are in it.
  const navs = usePositionNavs(st.positions);

  return (
    <div style={{ padding: "0 8px 8px 8px" }}>
      <div
        style={{
          background: "linear-gradient(120deg, rgba(150,112,255,0.2) 0%, rgba(255,183,101,0.12) 100%)",
          border: "1px solid rgba(213,198,255,0.34)",
          borderRadius: 16,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "13px 16px",
            flexWrap: "wrap",
            borderBottom: "1px solid rgba(213,198,255,0.26)",
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", color: "#ffd9a0", whiteSpace: "nowrap" }}>
            POSITIONS <span style={{ color: "#fdfbf7" }}>({st.positions.length})</span>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 11, fontWeight: 600, color: "#d5c6ff" }}>
            Every position is a token: open one to borrow against it, list it or close it
          </div>
        </div>

        <div className="laxu-dock-table">
        <div
          className="laxu-dock-grid"
          style={{
            display: "grid",
            gap: 8,
            padding: "10px 12px",
            gridTemplateColumns: COLS,
            borderBottom: "1px solid rgba(213,198,255,0.2)",
          }}
        >
          {HEADS.map((h) => (
            <div key={h} style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "#d5c6ff", ...CLIP }}>
              {h}
            </div>
          ))}
        </div>

        {st.positions.map((x) => {
          // Perpl's mark, and the token's NAV for PnL; until each has answered, the cell reads as a dash.
          const mark = engine.markOf(x.sym);
          const nav = navs[x.addr.toLowerCase()];
          const pnl = nav ? nav.pnlAbs : null;
          const pct = nav ? nav.pnlPct : 0;
          const pnlColor = pnl === null ? "#e3ddf4" : pnl >= 0 ? "#2fd18c" : "#ff6b57";
          const closing = x.status !== "open";

          return (
            <Link
              key={x.id}
              href={`/position/${x.addr}`}
              className="laxu-dock-row laxu-dock-grid"
              style={{
                display: "grid",
                gap: 8,
                padding: "12px 12px",
                alignItems: "center",
                gridTemplateColumns: COLS,
                cursor: "pointer",
                color: "inherit",
                textDecoration: "none",
                borderBottom: "1px solid rgba(213,198,255,0.16)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <Disc sym={x.sym} size={24} font={11} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#fdfbf7", ...CLIP }}>{x.sym}-PERP</div>
                  <div
                    style={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      letterSpacing: "0.06em",
                      color: x.side === "long" ? "#58e0a6" : "#ff8f7d",
                      ...CLIP,
                    }}
                  >
                    {x.side.toUpperCase()} &middot; {x.lev}&times;
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <div style={{ fontFamily: MONO, fontSize: 12.5, color: "#e3ddf4", ...CLIP }}>
                  {x.qty.toLocaleString("en-US", { maximumFractionDigits: 4 })} {x.sym}
                </div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: "#c3b8e3", ...CLIP }}>{money(x.entry, 2)}</div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <div style={{ fontFamily: MONO, fontSize: 12.5, color: "#e3ddf4", ...CLIP }}>{mark === null ? "—" : money(mark, 2)}</div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: "#ffb765", ...CLIP }}>
                  {money(liqOf(x.entry, x.side, x.lev), 0)}
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, overflow: "hidden" }}>
                <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", color: pnlColor }}>
                  {pnl === null ? "—" : (pnl >= 0 ? "+" : "−") + money(Math.abs(pnl), 2).slice(1)}
                </div>
                {pnl !== null && (
                  <div style={{ fontFamily: MONO, fontSize: 11, color: pnlColor }}>
                    {(pct >= 0 ? "+" : "−") + Math.abs(pct).toFixed(1)}%
                  </div>
                )}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", minWidth: 0, overflow: "hidden" }}>
                <div style={{ ...CHIP, background: "rgba(150,112,255,0.3)", color: "#d5c6ff" }}>TOKENIZED</div>
                {closing ? (
                  <div style={{ ...CHIP, background: "rgba(255,255,255,0.08)", color: "#a79bd0" }}>
                    {x.liquidated ? "LIQUIDATED" : "CLOSING"}
                  </div>
                ) : (
                  x.listed && <div style={{ ...CHIP, background: "rgba(255,183,101,0.16)", color: "#ffd9a0" }}>LISTED</div>
                )}
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "#ffd9a0", whiteSpace: "nowrap" }}>Open &rarr;</div>
                {!closing && <CloseButton position={x} engine={engine} />}
              </div>
            </Link>
          );
        })}

        </div>

        {st.positions.length === 0 && (
          <div style={{ padding: "30px 16px", textAlign: "center", fontSize: 13, fontWeight: 500, color: "#d5c6ff" }}>
            No positions yet. Open your first trade.
          </div>
        )}
      </div>
    </div>
  );
}
