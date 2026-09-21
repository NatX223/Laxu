"use client";

import { RANGES, TF_MINUTES, TIMEFRAMES, volFmt } from "./data";
import type { MarketView } from "./derive";
import { scale, shapeCandles, type TradeEngine } from "./engine";
import { Disc, MONO } from "./shared";

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * The candle chart. Everything is absolutely positioned in percentages off a
 * single padded price scale, so the panel resizes without re-measuring.
 */
export default function Chart({ engine, mkt }: { engine: TradeEngine; mkt: MarketView }) {
  const { st, set, mounted } = engine;
  const { list, mark, open, chg, chgColor, dp } = mkt;

  const sc = list.length ? scale(list) : null;
  const candles = shapeCandles(list);

  let volMax = 1;
  list.forEach((c) => {
    volMax = Math.max(volMax, c.v || 0);
  });
  const volBars = list.map((c, i) => ({
    key: i,
    c: c.c >= c.o ? "rgba(76,175,80,0.45)" : "rgba(232,84,58,0.45)",
    h: Math.max(2, ((c.v || 0) / volMax) * 40) + "px",
  }));

  const last = list.length ? list[list.length - 1] : null;
  const ohlc = last
    ? { o: last.o.toFixed(dp), h: last.h.toFixed(dp), l: last.l.toFixed(dp), c: last.c.toFixed(dp) }
    : { o: "—", h: "—", l: "—", c: "—" };

  // time axis and clock are wall-clock derived, so they stay blank until mount
  const tfMin = TF_MINUTES[st.tf] ?? 15;
  const n = Math.max(list.length, 1);
  const timeLabels = mounted
    ? [0, 1, 2, 3, 4, 5].map((k) => {
        const idx = Math.round(((k + 0.5) / 6) * (n - 1));
        const d = new Date(st.now - (n - 1 - idx) * tfMin * 60000);
        return {
          key: k,
          left: ((idx + 0.5) / n) * 100 + "%",
          v: tfMin >= 1440 ? `${d.getDate()}/${d.getMonth() + 1}` : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
        };
      })
    : [];
  const now = new Date(st.now);
  const clock = mounted ? `${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}:${pad2(now.getUTCSeconds())}` : "--:--:--";

  const markTop = sc ? sc.y(mark) + "%" : "50%";
  const axisLabels = sc
    ? [0, 1, 2, 3, 4].map((i) => ({
        key: i,
        v: (sc.hi - ((sc.hi - sc.lo) * i) / 4).toFixed(dp),
        top: Math.min(96, Math.max(4, i * 25)) + "%",
      }))
    : [];

  return (
    <div
      style={{
        flex: 1,
        minHeight: 560,
        background: "#0a0813",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 14,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* header: symbol, live dot, OHLC readout, timeframe pills */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "8px 10px",
          flexWrap: "wrap",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <Disc sym={st.market} size={17} font={9} />
        <div style={{ fontFamily: MONO, fontSize: 12, fontWeight: 500, color: "#d8d4e6", whiteSpace: "nowrap" }}>
          {st.market} &middot; {st.tf} &middot; arcus
        </div>
        <span
          style={{
            flex: "none",
            width: 9,
            height: 9,
            borderRadius: "50%",
            border: "2px solid #2fd18c",
            boxSizing: "border-box",
            animation: "laxu-pulse 1.8s ease-in-out infinite",
          }}
        />
        <div style={{ fontFamily: MONO, fontSize: 11, color: chgColor }}>
          O{ohlc.o} H{ohlc.h} L{ohlc.l} C{ohlc.c} {(chg >= 0 ? "+" : "−") + Math.abs(mark - open).toFixed(dp)} (
          {(chg >= 0 ? "+" : "") + chg.toFixed(2)}%)
        </div>
        <div style={{ flex: 1, minWidth: 6 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
          {TIMEFRAMES.map((t) => (
            <div
              key={t}
              onClick={() => set("tf", t)}
              style={{
                fontFamily: MONO,
                fontSize: 10.5,
                fontWeight: 600,
                padding: "4px 7px",
                borderRadius: 6,
                cursor: "pointer",
                transition: "background 0.2s ease",
                background: st.tf === t ? "rgba(150,112,255,0.4)" : "transparent",
                color: st.tf === t ? "#fdfbf7" : "#a79bd0",
              }}
            >
              {t}
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "stretch" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {/* price plot */}
          <div style={{ position: "relative", flex: 1, minHeight: 380, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} style={{ position: "absolute", left: 0, right: 0, height: 1, background: "rgba(255,255,255,0.045)", top: i * 25 + "%" }} />
            ))}
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} style={{ position: "absolute", top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,0.045)", left: ((i + 1) * 100) / 7 + "%" }} />
            ))}
            <div style={{ position: "absolute", left: 0, right: 0, height: 0, borderTop: "1px dotted rgba(255,255,255,0.32)", top: markTop }} />
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "stretch", gap: 1, padding: "0 1px" }}>
              {candles.map((c) => (
                <div key={c.key} style={{ flex: 1, minWidth: 0, position: "relative" }}>
                  <div style={{ position: "absolute", left: "50%", width: 1, marginLeft: -0.5, background: c.color, top: c.wickTop, height: c.wickH }} />
                  <div style={{ position: "absolute", left: 0, right: 0, background: c.color, top: c.bodyTop, height: c.bodyH }} />
                </div>
              ))}
            </div>
            <div style={{ position: "absolute", top: 0, bottom: 0, left: "64%", width: 0, borderLeft: "1px dashed rgba(255,255,255,0.24)" }} />
          </div>

          {/* volume histogram */}
          <div style={{ position: "relative", height: 50 }}>
            <div style={{ position: "absolute", left: 6, top: 3, zIndex: 2, fontFamily: MONO, fontSize: 10.5, color: "#8e86a3" }}>
              Volume{" "}
              <span style={{ color: last && last.c >= last.o ? "#4caf50" : "#e8543a" }}>{volFmt(last ? last.v : 0)}</span>
            </div>
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", gap: 1, padding: "0 1px" }}>
              {volBars.map((v) => (
                <div key={v.key} style={{ flex: 1, minWidth: 0, background: v.c, height: v.h }} />
              ))}
            </div>
            <div style={{ position: "absolute", top: 0, bottom: 0, left: "64%", width: 0, borderLeft: "1px dashed rgba(255,255,255,0.24)" }} />
          </div>

          {/* time axis */}
          <div style={{ position: "relative", height: 20, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            {timeLabels.map((t) => (
              <div
                key={t.key}
                style={{ position: "absolute", top: 3, transform: "translateX(-50%)", fontFamily: MONO, fontSize: 10, color: "#8e86a3", left: t.left }}
              >
                {t.v}
              </div>
            ))}
          </div>
        </div>

        {/* price axis */}
        <div style={{ flex: "none", width: 58, borderLeft: "1px solid rgba(255,255,255,0.06)", display: "flex", flexDirection: "column" }}>
          <div style={{ position: "relative", flex: 1, minHeight: 380 }}>
            {axisLabels.map((a) => (
              <div
                key={a.key}
                style={{ position: "absolute", right: 5, fontFamily: MONO, fontSize: 10, color: "#8e86a3", transform: "translateY(-50%)", top: a.top }}
              >
                {a.v}
              </div>
            ))}
            <div
              style={{
                position: "absolute",
                right: 3,
                padding: "2px 4px",
                borderRadius: 3,
                fontFamily: MONO,
                fontSize: 10,
                fontWeight: 600,
                color: "#08060f",
                transform: "translateY(-50%)",
                background: chgColor,
                top: markTop,
              }}
            >
              {mark.toFixed(dp)}
            </div>
          </div>
          <div style={{ position: "relative", height: 50 }}>
            <div style={{ position: "absolute", right: 5, top: 2, fontFamily: MONO, fontSize: 10, color: "#8e86a3", whiteSpace: "nowrap" }}>
              {volFmt(volMax)}
            </div>
            <div style={{ position: "absolute", right: 5, bottom: 2, fontFamily: MONO, fontSize: 10, color: "#8e86a3" }}>0</div>
          </div>
          <div style={{ flex: "none", height: 20 }} />
        </div>
      </div>

      {/* footer: range pills and the chart-provider strip */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderTop: "1px solid rgba(255,255,255,0.06)",
          flexWrap: "wrap",
        }}
      >
        {RANGES.map((r) => (
          <div
            key={r}
            onClick={() => set("range", r)}
            style={{
              fontFamily: MONO,
              fontSize: 10.5,
              fontWeight: 500,
              padding: "3px 6px",
              borderRadius: 5,
              cursor: "pointer",
              color: st.range === r ? "#fdfbf7" : "#8e86a3",
              background: st.range === r ? "rgba(150,112,255,0.35)" : "transparent",
            }}
          >
            {r}
          </div>
        ))}
        <div style={{ flex: 1, minWidth: 6 }} />
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#8e86a3", whiteSpace: "nowrap" }}>{clock} UTC</div>
        <div style={{ width: 1, height: 12, background: "rgba(255,255,255,0.12)" }} />
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#8e86a3" }}>%</div>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#8e86a3" }}>log</div>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#d8d4e6" }}>auto</div>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "#6f6788", whiteSpace: "nowrap" }}>
          CHART BY TRADINGVIEW
        </div>
      </div>
    </div>
  );
}
