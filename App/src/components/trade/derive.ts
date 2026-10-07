import { useAsset } from "@/lib/asset";
import type { MarketState } from "@/lib/perplMarketData";
import { useRawMarketStates } from "@/lib/perplMarketData";
import { useTokenCounts } from "@/lib/tokenCounts";
import { cat } from "./data";
import { statsFor, type MarketStats } from "./stats";

export type MarketView = {
  sym: string;
  /** Perpl's mark; null until Perpl (or the backend's last sync) has one for this market. */
  mark: number | null;
  /** Perpl's 24h reference price (`prv`); null when it hasn't said. */
  open: number | null;
  chg: number;
  chgColor: string;
  /** The market's own price precision (Perpl's `priceDecimals`). */
  dp: number;
  state: MarketState | null;
  stats: MarketStats;
};

/** The handful of numbers the stats bar, chart, book and ticket all read, for the market on screen. */
export function useMarketView(sym: string): MarketView {
  const raw = useRawMarketStates();
  const { decimals } = useAsset();
  const counts = useTokenCounts();
  const live = cat(sym).live;
  // no clock here: the funding countdown lives in StatsBar, so the whole screen never ticks each second
  const stats = statsFor(live, { raw, decimals, counts }, 0);
  const chg = stats.changePct ?? 0;
  return {
    sym,
    mark: stats.mark,
    open: stats.mark !== null && stats.changeAbs !== null ? stats.mark - stats.changeAbs : null,
    chg,
    chgColor: chg >= 0 ? "#2fd18c" : "#ff6b57",
    dp: live?.priceDecimals ?? 2,
    state: stats.state,
    stats,
  };
}
