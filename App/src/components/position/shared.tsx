import type { CSSProperties, ReactNode } from "react";

export { SERIF } from "../landing/shared";
export const MONO = "var(--font-ibm-plex-mono), monospace";

/** The frosted card every block on this screen sits in. */
export function Panel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        borderRadius: 18,
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(255,255,255,0.05)",
        backdropFilter: "blur(16px)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Its header strip: a tracked-out label on the left, anything else on the right. */
export function PanelHead({
  label,
  children,
  style,
}: {
  label: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "12px 16px",
        borderBottom: "1px solid rgba(255,255,255,0.1)",
        ...style,
      }}
    >
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.14em", color: "#c3b8e3" }}>{label}</div>
      {children}
    </div>
  );
}

/** The pill badges under the position name. */
export function Badge({
  bg,
  ink,
  children,
  style,
  className,
  href,
}: {
  bg: string;
  ink: string;
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
  href?: string;
}) {
  const shape: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.1em",
    padding: "5px 11px",
    borderRadius: 99,
    background: bg,
    color: ink,
    ...style,
  };
  return href ? (
    <a href={href} className={className} style={shape}>
      {children}
    </a>
  ) : (
    <div className={className} style={shape}>
      {children}
    </div>
  );
}

/** Every cell on the screen is separated by a 1px rule of the same wash. */
export const HAIRLINE = "rgba(255,255,255,0.09)";
/** …over the cards' own ground, which is opaque where the frost is not. */
export const CELL_BG = "#241c46";
