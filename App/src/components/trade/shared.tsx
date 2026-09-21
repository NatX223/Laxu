import type { CSSProperties } from "react";
import { initial as initialOf, cat, tintInk } from "./data";

/** Archivo is set on `body`; the display serif and the mono opt in. */
export { SERIF } from "../landing/shared";
export const MONO = "var(--font-ibm-plex-mono), monospace";

/**
 * The tinted market disc. Every instance in the design is the same thing at a
 * different size: a logo image when the market has one, otherwise the first
 * letter of the ticker on the market's tint.
 */
export function Disc({ sym, size, font, style }: { sym: string; size: number; font: number; style?: CSSProperties }) {
  const market = cat(sym);
  return (
    <div
      style={{
        flex: "none",
        width: size,
        height: size,
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: font,
        fontWeight: 700,
        color: tintInk(sym),
        backgroundColor: market.tint,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundImage: market.logo ? `url(${market.logo})` : undefined,
        ...style,
      }}
    >
      {initialOf(sym)}
    </div>
  );
}

/** The all-caps micro label used for every field name on this screen. */
export function Key({ children, style }: { children: React.ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "#a79bd0", ...style }}>
      {children}
    </div>
  );
}
