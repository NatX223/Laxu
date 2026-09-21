import { cat } from "./data";
import type { Candle, TradeState } from "./engine";

export type MarketView = {
  sym: string;
  list: Candle[];
  mark: number;
  open: number;
  chg: number;
  chgColor: string;
  /** The prototype pins the active market's price precision to 2 decimals. */
  dp: number;
};

/** The handful of numbers the stats bar, chart, book and ticket all read. */
export function deriveMarket(st: TradeState): MarketView {
  const sym = st.market;
  const mark = st.px[sym] ?? cat(sym).base;
  const list = st.candles[sym] || [];
  const open = list.length ? list[0].o : mark;
  const chg = open ? ((mark - open) / open) * 100 : 0;
  return { sym, list, mark, open, chg, chgColor: chg >= 0 ? "#2fd18c" : "#ff6b57", dp: 2 };
}
