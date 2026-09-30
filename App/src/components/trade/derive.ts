import { cat } from "./data";
import type { Candle, TradeState } from "./engine";

export type MarketView = {
  sym: string;
  list: Candle[];
  /** Arcus's mark; null until Arcus has answered for this market. */
  mark: number | null;
  /** The 24h reference price: the chart's close a day back, else implied by Arcus's 24h change. */
  open: number | null;
  chg: number;
  chgColor: string;
  /** The prototype pins the active market's price precision to 2 decimals. */
  dp: number;
};

/** The handful of numbers the stats bar, chart, book and ticket all read. */
export function deriveMarket(st: TradeState): MarketView {
  const sym = st.market;
  const mark = st.px[sym] ?? null;
  const list = st.candles[sym] || [];
  const change24h = Number(cat(sym).live?.priceChange24h);
  const open =
    st.pxRef[sym] ?? (mark !== null && Number.isFinite(change24h) ? mark / (1 + change24h) : null);
  const chg = mark !== null && open ? ((mark - open) / open) * 100 : 0;
  return { sym, list, mark, open, chg, chgColor: chg >= 0 ? "#2fd18c" : "#ff6b57", dp: 2 };
}
