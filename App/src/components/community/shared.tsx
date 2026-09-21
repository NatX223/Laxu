import type { CSSProperties } from "react";

export { SERIF } from "../landing/shared";
export const MONO = "var(--font-ibm-plex-mono), monospace";

/**
 * The tinted token disc. Note the prototype paints the ticker's initial on
 * every disc — including the two that carry a logo image — so it does that
 * here too.
 */
export function Disc({
  size,
  font,
  accent,
  logo,
  initial,
  style,
}: {
  size: number;
  font: number;
  accent: string;
  logo: string;
  initial: string;
  style?: CSSProperties;
}) {
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
        color: "#16130f",
        backgroundColor: accent,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundImage: logo ? `url(${logo})` : undefined,
        ...style,
      }}
    >
      {initial}
    </div>
  );
}
