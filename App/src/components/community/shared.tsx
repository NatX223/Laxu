"use client";

import type { CSSProperties } from "react";
import { marketFor, useMarkets } from "@/lib/markets";
import MarketIcon from "../MarketIcon";

export { SERIF } from "../landing/shared";
export const MONO = "var(--font-ibm-plex-mono), monospace";

/**
 * The token disc — the shared MarketIcon. The live Arcus logo for `base` wins
 * when the market list has it; otherwise the disc's own logo, otherwise a
 * letter avatar.
 */
export function Disc({
  size,
  font,
  base,
  logo,
  style,
}: {
  size: number;
  font: number;
  /** Underlying market's base asset, e.g. "ETH". */
  base: string;
  logo?: string;
  style?: CSSProperties;
}) {
  useMarkets(); // re-render when the live list (and its logos) lands
  return (
    <MarketIcon logoUrl={marketFor(base)?.logoUrl ?? (logo || null)} baseAsset={base} size={size} font={font} style={style} />
  );
}
