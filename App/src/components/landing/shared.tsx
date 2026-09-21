/** Archivo is set on `body`; only the display serif needs opting into. */
export const SERIF = "var(--font-instrument-serif), serif";

/**
 * The repeating grain wash every section lays over its gradient.
 *
 * `mix-blend-mode` only blends against the backdrop inside the nearest
 * stacking context, so `zIndex` belongs on this element — wrapping it in a
 * positioned, z-indexed parent isolates the blend and leaves flat noise.
 */
export function Grain({ opacity = 0.22, zIndex }: { opacity?: number; zIndex?: number }) {
  return (
    <div
      className="laxu-grain"
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        zIndex,
        pointerEvents: "none",
        opacity,
        mixBlendMode: "overlay",
      }}
    />
  );
}
