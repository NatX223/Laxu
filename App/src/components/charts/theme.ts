import {
  ColorType,
  CrosshairMode,
  LineStyle,
  type ChartOptions,
  type DeepPartial,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { MONO } from "../position/shared";

/**
 * "Living Frost" colours as the screens already paint them — the violet,
 * amber, green, rose and ink every card on the position page uses — so the
 * charts read as part of the same surface.
 */
export const FROST = {
  violet: "#9670ff",
  amber: "#ffd9a0",
  green: "#5fe3a8",
  rose: "#ff7d92",
  ink: "#fdfbf7",
  /** axis labels */
  muted: "#8f85bd",
  /** the 1px rules between cells */
  hairline: "rgba(255,255,255,0.09)",
  crosshair: "rgba(194,182,228,0.45)",
} as const;

/**
 * Full-size charts. Transparent, so the frosted panel shows through, and the
 * TradingView attribution logo left ON — the Lightweight Charts licence
 * requires crediting TradingView (the footer carries the text credit too).
 */
export const baseChartOptions: DeepPartial<ChartOptions> = {
  autoSize: true,
  layout: {
    background: { type: ColorType.Solid, color: "transparent" },
    textColor: FROST.muted,
    fontFamily: MONO,
    fontSize: 10,
    attributionLogo: true,
  },
  grid: {
    vertLines: { color: "rgba(255,255,255,0.04)" },
    horzLines: { color: "rgba(255,255,255,0.05)" },
  },
  rightPriceScale: { borderColor: FROST.hairline },
  timeScale: { borderColor: FROST.hairline, timeVisible: true, secondsVisible: false },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: FROST.crosshair, labelBackgroundColor: "#3a2f6b" },
    horzLine: { color: FROST.crosshair, labelBackgroundColor: "#3a2f6b" },
  },
};

/**
 * Show the trailing `windowSec` of a chart, or everything when null. Setting a
 * range on an empty series throws, so that case falls back to fitting.
 */
export function applyWindow(chart: IChartApi, windowSec: number | null | undefined, earliest?: number): void {
  const scale = chart.timeScale();
  const to = Math.floor(Date.now() / 1000);
  // a window reaching past the loaded history would only show empty space
  if (!windowSec || (earliest !== undefined && to - windowSec <= earliest)) {
    scale.fitContent();
    return;
  }
  try {
    scale.setVisibleRange({ from: (to - windowSec) as UTCTimestamp, to: to as UTCTimestamp });
  } catch {
    scale.fitContent();
  }
}

/** Entry references: amber, dashed. */
export const entryLine = {
  color: FROST.amber,
  lineWidth: 1,
  lineStyle: LineStyle.Dashed,
  axisLabelVisible: true,
  title: "Entry",
} as const;
