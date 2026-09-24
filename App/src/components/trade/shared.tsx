import type { CSSProperties } from "react";
import MarketIcon from "../MarketIcon";
import { cat } from "./data";

/** Archivo is set on `body`; the display serif and the mono opt in. */
export { SERIF } from "../landing/shared";
export const MONO = "var(--font-ibm-plex-mono), monospace";

/**
 * The market disc, at whatever size the design calls for — the shared
 * MarketIcon: Arcus's logo, or a letter avatar when there is none.
 */
export function Disc({ sym, size, font, style }: { sym: string; size: number; font: number; style?: CSSProperties }) {
  return <MarketIcon logoUrl={cat(sym).logo} baseAsset={sym} size={size} font={font} style={style} />;
}

/** The all-caps micro label used for every field name on this screen. */
export function Key({ children, style }: { children: React.ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0", ...style }}>
      {children}
    </div>
  );
}
