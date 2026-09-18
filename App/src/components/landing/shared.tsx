/** Archivo is set on `body`; only the display serif needs opting into. */
export const SERIF = "var(--font-instrument-serif), serif";

/** The repeating grain wash every section lays over its gradient. */
export function Grain({ opacity = 0.22 }: { opacity?: number }) {
  return (
    <div
      className="laxu-grain"
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        opacity,
        mixBlendMode: "overlay",
      }}
    />
  );
}
