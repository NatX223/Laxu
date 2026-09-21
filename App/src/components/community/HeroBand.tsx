import type { Derived } from "./derive";
import { Disc, MONO, SERIF } from "./shared";

const MASK = "linear-gradient(90deg, transparent 0%, #000 5%, #000 88%, transparent 100%)";

/** The headline band: stacked wave field, hero stats and the volume ticker. */
export default function HeroBand({ vals }: { vals: Derived }) {
  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        borderBottom: "1px solid rgba(255,255,255,0.1)",
        background:
          "radial-gradient(74% 120% at 18% 6%, #3b2a78 0%, rgba(59,42,120,0) 62%), radial-gradient(70% 130% at 86% 12%, #6b3a86 0%, rgba(107,58,134,0) 58%), linear-gradient(180deg, #241c46 0%, #1e1740 58%, #1c1638 100%)",
      }}
    >
      <svg
        viewBox="0 0 1200 300"
        preserveAspectRatio="none"
        aria-hidden="true"
        style={{ position: "absolute", left: 0, right: 0, bottom: 0, width: "100%", height: 300, opacity: 0.85 }}
      >
        <defs>
          <linearGradient id="lxA" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffb765" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#ffb765" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="lxB" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e0651c" stopOpacity="0.42" />
            <stop offset="100%" stopColor="#e0651c" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="lxC" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#9670ff" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#9670ff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="lxD" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#dba4b4" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#dba4b4" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={vals.waveC} fill="url(#lxC)" />
        <path d={vals.waveD} fill="url(#lxD)" />
        <path d={vals.waveB} fill="url(#lxB)" />
        <path d={vals.waveA} fill="url(#lxA)" />
        <path d={vals.lineC} fill="none" stroke="#b79dff" strokeWidth="1.4" vectorEffect="non-scaling-stroke" opacity="0.7" />
        <path d={vals.lineA} fill="none" stroke="#ffd9a0" strokeWidth="1.6" vectorEffect="non-scaling-stroke" opacity="0.85" />
      </svg>

      <div
        style={{
          position: "relative",
          zIndex: 2,
          maxWidth: 1320,
          margin: "0 auto",
          padding: "56px 28px 40px",
          display: "flex",
          flexDirection: "column",
          gap: 30,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 32, flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 640 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.16em", color: "#ffd9a0" }}>
              COMMUNITY MARKET
            </div>
            <h1
              style={{
                margin: 0,
                fontFamily: SERIF,
                fontSize: "clamp(42px, 5vw, 66px)",
                fontWeight: 400,
                lineHeight: 0.98,
                letterSpacing: "-0.02em",
                color: "#fdfbf7",
              }}
            >
              Positions other people <i>minted</i>
            </h1>
            <div style={{ fontSize: 15, lineHeight: 1.6, fontWeight: 500, color: "#c2b6e4", textWrap: "pretty" }}>
              Every token here is one live position — its own entry, size and leverage. Buy in, and you hold a slice of
              somebody else&rsquo;s conviction.
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {vals.heroStats.map((s) => (
              <div
                key={s.k}
                style={{
                  minWidth: 150,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  padding: "14px 18px",
                  borderRadius: 14,
                  background: "rgba(255,255,255,0.07)",
                  border: "1px solid rgba(255,255,255,0.14)",
                  backdropFilter: "blur(14px)",
                }}
              >
                <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0" }}>{s.k}</div>
                <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 600, color: s.c }}>{s.v}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, overflow: "hidden", maskImage: MASK, WebkitMaskImage: MASK }}>
          {vals.ticker.map((t) => (
            <div
              key={t.sym}
              style={{
                flex: "none",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 14px 7px 8px",
                borderRadius: 99,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                backdropFilter: "blur(10px)",
              }}
            >
              <Disc size={20} font={9.5} accent={t.accent} logo={t.logo} initial={t.initial} />
              <div style={{ fontFamily: MONO, fontSize: 11.5, color: "#fdfbf7", whiteSpace: "nowrap" }}>{t.sym}</div>
              <div style={{ fontFamily: MONO, fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap", color: t.c }}>
                {t.chg}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
