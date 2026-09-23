/**
 * The attribution the Lightweight Charts licence requires. Every screen that
 * draws a chart carries it — it is also what lets the discovery sparklines
 * hide their per-chart logo.
 */
export default function TradingViewCredit({ color = "#8d81b0", style }: { color?: string; style?: React.CSSProperties }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 500, color, ...style }}>
      Charts by{" "}
      <a
        href="https://www.tradingview.com/"
        target="_blank"
        rel="noopener noreferrer"
        className="laxu-foot-link"
        style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: 2 }}
      >
        TradingView
      </a>{" "}
      &middot; Lightweight Charts&trade;
    </div>
  );
}
