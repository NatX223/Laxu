"use client";

import { useMemo } from "react";
import { useBook, useTrades, type Book } from "@/lib/perplMarketData";
import { cat } from "./data";
import type { MarketView } from "./derive";
import type { TradeEngine } from "./engine";
import { MONO } from "./shared";

const HEAD: React.CSSProperties = { fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em", color: "#a79bd0" };

/** Rows shown per side of the ladder. */
const LEVELS = 8;
/** Bars per side of the depth card. */
const DEPTH_LEVELS = 9;

const pad2 = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

type Row = { p: string; s: string; depth: string };

/** Best-first levels with a cumulative-size wash scaled against the deepest side shown. */
function ladder(levels: Book["bids"], dp: number, sizeDp: number, max: number): Row[] {
  let cum = 0;
  return levels.slice(0, LEVELS).map((l) => {
    cum += l.size;
    return { p: l.price.toFixed(dp), s: l.size.toFixed(sizeDp), depth: (max > 0 ? Math.min(100, (cum / max) * 100) : 0) + "%" };
  });
}

/** Cumulative depth, farthest bid → nearest bid → nearest ask → farthest ask, as bar heights in percent. */
function depthBars(book: Book | null): { bars: Array<{ bid: boolean; h: number }>; range: string } {
  if (!book || book.bids.length === 0 || book.asks.length === 0) return { bars: [], range: "" };
  const bids = book.bids.slice(0, DEPTH_LEVELS);
  const asks = book.asks.slice(0, DEPTH_LEVELS);
  const cumulative = (levels: Book["bids"]) => {
    let c = 0;
    return levels.map((l) => (c += l.size));
  };
  const bidCum = cumulative(bids);
  const askCum = cumulative(asks);
  const max = Math.max(bidCum[bidCum.length - 1], askCum[askCum.length - 1]) || 1;
  const mid = (book.bids[0].price + book.asks[0].price) / 2;
  const reach = Math.max(mid - bids[bids.length - 1].price, asks[asks.length - 1].price - mid) / mid;
  return {
    bars: [
      ...bidCum
        .map((c) => ({ bid: true, h: Math.max(6, (c / max) * 100) }))
        .reverse(),
      ...askCum.map((c) => ({ bid: false, h: Math.max(6, (c / max) * 100) })),
    ],
    range: `±${(reach * 100).toFixed(reach < 0.01 ? 2 : 1)}%`,
  };
}

/** Order book / tape, plus the depth card below it. Perpl's real L2 book and trades. */
export default function BookPanel({
  engine,
  mkt,
  showDepth = true,
}: {
  engine: TradeEngine;
  mkt: MarketView;
  showDepth?: boolean;
}) {
  const { st, set } = engine;
  const { mark, chgColor, dp } = mkt;
  const live = cat(st.market).live;
  const sizeDp = Math.min(live?.sizeDecimals ?? 2, 4);

  // Only what the screen shows is polled: the book while it (or the depth card) is up, the tape on its tab.
  const { book, error: bookError } = useBook(live, st.tab === "book" || showDepth);
  const { trades, error: tradesError } = useTrades(live, st.tab === "trades");

  const rows = useMemo(() => {
    if (!book) return null;
    const max = Math.max(
      book.bids.slice(0, LEVELS).reduce((a, l) => a + l.size, 0),
      book.asks.slice(0, LEVELS).reduce((a, l) => a + l.size, 0),
    );
    // asks print highest-first so the best ask sits against the spread
    return { asks: ladder(book.asks, dp, sizeDp, max).reverse(), bids: ladder(book.bids, dp, sizeDp, max) };
  }, [book, dp, sizeDp]);

  const spread = book && book.bids[0] && book.asks[0] ? book.asks[0].price - book.bids[0].price : null;
  const depth = useMemo(() => depthBars(book), [book]);

  return (
    <div className="laxu-trade-book" style={{ flex: "0 1 184px", minWidth: 128, display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          flex: "none",
          background: "rgba(255,255,255,0.045)",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 16,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
          {(["book", "trades"] as const).map((tab) => (
            <div
              key={tab}
              onClick={() => set("tab", tab)}
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.1em",
                cursor: "pointer",
                color: st.tab === tab ? "#fdfbf7" : "#7b719e",
              }}
            >
              {tab.toUpperCase()}
            </div>
          ))}
        </div>

        {st.tab === "book" && (
          <div style={{ display: "flex", flexDirection: "column", padding: "8px 0" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, padding: "0 14px 6px" }}>
              <div style={HEAD}>PRICE</div>
              <div style={{ ...HEAD, textAlign: "right" }}>SIZE</div>
            </div>

            {rows === null ? (
              <Status text={bookError ? "Order book unavailable" : "Loading order book…"} />
            ) : (
              <>
                {rows.asks.map((a, i) => (
                  <Ladder key={`a${i}`} row={a} ink="#ff8f7d" fill="rgba(255,107,87,0.16)" />
                ))}

                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "9px 14px",
                    margin: "6px 0",
                    background: "rgba(255,255,255,0.06)",
                  }}
                >
                  <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 600, color: chgColor }}>
                    {mark === null
                      ? "—"
                      : "$" + mark.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#a79bd0" }}>
                    spread {spread === null ? "—" : spread.toFixed(dp)}
                  </div>
                </div>

                {rows.bids.map((b, i) => (
                  <Ladder key={`b${i}`} row={b} ink="#58e0a6" fill="rgba(47,209,140,0.16)" />
                ))}
              </>
            )}
          </div>
        )}

        {st.tab === "trades" && (
          <div style={{ display: "flex", flexDirection: "column", padding: "8px 0" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 0.8fr", gap: 6, padding: "0 14px 6px" }}>
              <div style={HEAD}>PRICE</div>
              <div style={{ ...HEAD, textAlign: "right" }}>SIZE</div>
              <div style={{ ...HEAD, textAlign: "right" }}>TIME</div>
            </div>
            {trades === null ? (
              <Status text={tradesError ? "Trades unavailable" : "Loading trades…"} />
            ) : trades.length === 0 ? (
              <Status text="No recent trades" />
            ) : (
              trades.slice(0, 15).map((t) => (
                <div key={t.key} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 0.8fr", gap: 6, padding: "3.5px 14px" }}>
                  <div style={{ fontFamily: MONO, fontSize: 11.5, color: t.buy ? "#58e0a6" : "#ff8f7d" }}>{t.price.toFixed(dp)}</div>
                  <div style={{ fontFamily: MONO, fontSize: 11.5, color: "#e3ddf4", textAlign: "right" }}>{t.size.toFixed(sizeDp)}</div>
                  <div style={{ fontFamily: MONO, fontSize: 11, color: "#998dbd", textAlign: "right" }}>{clock(t.time)}</div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {showDepth && (
        <div
          style={{
            flex: "1 1 auto",
            minHeight: 120,
            background: "rgba(255,255,255,0.045)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 16,
            padding: "12px 14px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" }}>DEPTH</div>
            <div style={{ fontFamily: MONO, fontSize: 10, color: "#998dbd" }}>{depth.range}</div>
          </div>
          {depth.bars.length === 0 ? (
            <Status text={bookError ? "Depth unavailable" : "Loading…"} />
          ) : (
            <div style={{ display: "flex", alignItems: "flex-end", gap: 2, flex: 1, minHeight: 56 }}>
              {depth.bars.map((d, i) => (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    borderRadius: "2px 2px 0 0",
                    background: d.bid ? "rgba(47,209,140,0.55)" : "rgba(255,107,87,0.55)",
                    height: d.h + "%",
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Status({ text }: { text: string }) {
  return <div style={{ padding: "18px 14px", fontSize: 11.5, fontWeight: 600, color: "#8e86a3", textAlign: "center" }}>{text}</div>;
}

/** One book row: the cumulative-depth wash sits behind price and size. */
function Ladder({ row, ink, fill }: { row: Row; ink: string; fill: string }) {
  return (
    <div style={{ position: "relative", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, padding: "3.5px 14px" }}>
      <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, background: fill, width: row.depth }} />
      <div style={{ position: "relative", fontFamily: MONO, fontSize: 11.5, color: ink }}>{row.p}</div>
      <div style={{ position: "relative", fontFamily: MONO, fontSize: 11.5, color: "#e3ddf4", textAlign: "right" }}>{row.s}</div>
    </div>
  );
}
