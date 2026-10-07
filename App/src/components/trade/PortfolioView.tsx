"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getPortfolio, type Portfolio, type PortfolioHolding } from "@/lib/api";
import { useSession } from "@/lib/session";
import MarketIcon from "../MarketIcon";
import { money } from "./data";
import { MONO, SERIF } from "./shared";

/** Holdings move on the reporter's cadence; a buy-in settling on Perpl is what this mostly waits on. */
const PORTFOLIO_POLL_MS = 20_000;

type Load = "loading" | "ready" | "error";

const num = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

const signed = (n: number) => (n >= 0 ? "+" : "−") + money(Math.abs(n), 2).slice(1);

const tokenUnits = (s: string) =>
  num(s).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/**
 * Portfolio: every position token the signed-in wallet holds, whether it
 * minted the position or bought into someone else's, from
 * `GET /users/:address/portfolio`. Shares posted as loan collateral count as
 * held. Buy-ins still settling on Perpl are listed above the holdings.
 */
export default function PortfolioView() {
  const { authenticated, user, userFailed, login } = useSession();
  const owner = user?.walletAddress?.toLowerCase() ?? null;
  const [data, setData] = useState<{ for: string; portfolio: Portfolio } | null>(null);
  const [load, setLoad] = useState<Load>("loading");

  const refresh = useCallback(() => {
    if (!owner) return;
    getPortfolio(owner)
      .then((portfolio) => {
        setData({ for: owner, portfolio });
        setLoad("ready");
      })
      .catch((error) => {
        console.error("GET /users/:address/portfolio failed", error);
        // a failed refresh keeps the last good portfolio on screen
        setLoad((l) => (l === "ready" ? l : "error"));
      });
  }, [owner]);

  useEffect(() => {
    if (!owner) return;
    refresh();
    const id = setInterval(refresh, PORTFOLIO_POLL_MS);
    return () => clearInterval(id);
  }, [owner, refresh]);

  if (!authenticated) {
    return (
      <Message title="Portfolio" body="Log in to see the position tokens you hold.">
        <button type="button" onClick={login} style={BUTTON}>
          Log in
        </button>
      </Message>
    );
  }

  if (!owner && userFailed) {
    return <Message title="Couldn’t load your account" body="The Laxu backend didn’t recognise this login. Refresh the page to try again." />;
  }

  // never show the last account's holdings after a switch
  const portfolio = data && data.for === owner ? data.portfolio : null;
  if (!portfolio) {
    return load === "error" ? (
      <Message title="Couldn’t load your portfolio" body="The Laxu backend didn’t answer. Retrying every 20 seconds." />
    ) : (
      <Message title="Loading your portfolio…" body="Reading every position token this wallet holds." />
    );
  }

  const minted = new Set(portfolio.created.map((c) => c.address.toLowerCase()));
  const holdings = [...portfolio.holdings].sort((a, b) => num(b.value) - num(a.value));
  const totalValue = holdings.reduce((a, h) => a + num(h.value), 0);
  const totalPnl = holdings.reduce((a, h) => a + num(h.pnl), 0);
  const boughtIn = holdings.filter((h) => !minted.has(h.position.address.toLowerCase())).length;
  const pendingBuyIns = portfolio.pending.filter((p) => p.type === "buy_in");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.16em", color: "#ffd9a0" }}>PORTFOLIO</div>
          <div style={{ fontFamily: SERIF, fontSize: "clamp(30px, 8vw, 40px)", lineHeight: 1, letterSpacing: "-0.02em", color: "#fdfbf7" }}>
            Tokens you <i>hold</i>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Summary label="VALUE" value={money(totalValue, 2)} ink="#fdfbf7" />
          <Summary label="PNL" value={signed(totalPnl)} ink={totalPnl >= 0 ? "#2fd18c" : "#ff6b57"} />
          <Summary label="MINTED · BOUGHT IN" value={`${holdings.length - boughtIn} · ${boughtIn}`} ink="#d5c6ff" />
        </div>
      </div>

      {pendingBuyIns.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "12px 16px",
            borderRadius: 14,
            background: "rgba(255,183,101,0.1)",
            border: "1px solid rgba(255,183,101,0.3)",
          }}
        >
          {pendingBuyIns.map((p) => (
            <Link key={p.position + p.requestedAt} href={`/position/${p.position}`} style={{ fontSize: 12.5, fontWeight: 600, color: "#ffd9a0" }}>
              Buy-in of {money(num(p.amount), 2)} settling on Perpl · {p.position.slice(0, 6)}…{p.position.slice(-4)} →
            </Link>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fill, minmax(min(320px, 100%), 1fr))" }}>
        {holdings.map((h) => (
          <HoldingCard key={h.position.address} h={h} minted={minted.has(h.position.address.toLowerCase())} />
        ))}
      </div>

      {holdings.length === 0 && (
        <Message
          title="No position tokens yet"
          body="Open a trade to mint your own, or buy into one from the community market."
        >
          <Link href="/community" style={BUTTON}>
            Browse the community
          </Link>
        </Message>
      )}
    </div>
  );
}

function HoldingCard({ h, minted }: { h: PortfolioHolding; minted: boolean }) {
  const p = h.position;
  const pnl = num(h.pnl);
  const inLoan = num(h.inCollateral);
  const title = p.nickname || `${p.market.baseAsset} ${p.direction}, ${p.leverage}×`;
  const cells = [
    { k: "TOKENS", v: tokenUnits(h.shares), c: "#fdfbf7" },
    { k: "VALUE", v: money(num(h.value), 2), c: "#fdfbf7" },
    { k: "NET DEPOSITED", v: money(num(h.netDeposited), 2), c: "#fdfbf7" },
    { k: "PNL", v: signed(pnl), c: pnl >= 0 ? "#2fd18c" : "#ff6b57" },
  ];
  const footer = h.repayToClaim
    ? "Repay your loan to claim →"
    : p.status === "open"
      ? inLoan > 0
        ? `${tokenUnits(h.inCollateral)} in a loan →`
        : "Redeem · Borrow →"
      : "Settling →";

  return (
    <Link
      href={`/position/${p.address}`}
      style={{
        display: "block",
        borderRadius: 18,
        overflow: "hidden",
        color: "inherit",
        textDecoration: "none",
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(255,255,255,0.045)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "14px 16px",
          background: minted ? "rgba(150,112,255,0.42)" : "rgba(255,183,101,0.22)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <MarketIcon logoUrl={p.market.logoUrl} baseAsset={p.market.baseAsset} size={26} font={12} />
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <div
              style={{ fontFamily: SERIF, fontSize: 19, color: "#fdfbf7", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
            >
              {title}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#d5c6ff" }}>
              {minted ? "minted by you" : `by ${p.creator.tag ? "@" + p.creator.tag : p.creator.address.slice(0, 6) + "…"}`}
            </div>
          </div>
        </div>
        <div
          style={{
            flex: "none",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.08em",
            padding: "5px 10px",
            borderRadius: 99,
            background: "#fdfbf7",
            color: minted ? "#6f45e0" : "#b5651d",
          }}
        >
          {minted ? "MINTED" : "BOUGHT IN"}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: "rgba(255,255,255,0.09)" }}>
        {cells.map((c) => (
          <div key={c.k} style={{ padding: "12px 16px", background: "#241c46", display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em", color: "#a79bd0" }}>{c.k}</div>
            <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 500, color: c.c }}>{c.v}</div>
          </div>
        ))}
      </div>

      <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ fontFamily: MONO, fontSize: 11, color: "#a79bd0" }}>{`${p.address.slice(0, 6)}…${p.address.slice(-4)}`}</div>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: "#ffd9a0" }}>{footer}</div>
      </div>
    </Link>
  );
}

const BUTTON: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 700,
  color: "#fdfbf7",
  background: "#9670ff",
  border: "none",
  padding: "9px 18px",
  borderRadius: 99,
  cursor: "pointer",
};

function Message({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        padding: "64px 20px",
        textAlign: "center",
        background: "rgba(255,255,255,0.045)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 16,
      }}
    >
      <div style={{ fontFamily: SERIF, fontSize: 30, color: "#fdfbf7" }}>{title}</div>
      <div style={{ fontSize: 14, fontWeight: 500, color: "#a79bd0" }}>{body}</div>
      {children}
    </div>
  );
}

function Summary({ label, value, ink }: { label: string; value: string; ink: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "12px 18px",
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 12,
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 17, fontWeight: 600, color: ink }}>{value}</div>
    </div>
  );
}
