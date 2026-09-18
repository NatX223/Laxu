"use client";

import { useEffect, useRef, useState } from "react";

/** The design switches to its stacked layout below this width. */
export const NARROW_BREAKPOINT = 760;

/**
 * Mirrors `resolve(attr)` in the prototype: whichever element owns the 1px band
 * at the vertical centre of the viewport wins. Elements fully above the band
 * raise the floor, so scrolling past the last one keeps it active.
 *
 * Entry order in batched IntersectionObserver callbacks is unreliable, so the
 * index is resolved from geometry on every tick rather than from entries.
 */
function resolveIndex(attr: string): number | null {
  const rows = Array.from(document.querySelectorAll(`[${attr}]`));
  if (!rows.length) return null;

  const mid = window.innerHeight / 2;
  let idx = 0;

  rows.forEach((el) => {
    const i = Number(el.getAttribute(attr));
    if (Number.isNaN(i)) return;
    const r = el.getBoundingClientRect();
    if (r.top <= mid && r.bottom > mid) {
      idx = i; // owns the band
    } else if (r.bottom <= mid) {
      idx = Math.max(idx, i); // fully above
    }
  });

  return idx;
}

/**
 * Tracks which `[data-*-index]` row currently owns the centre band.
 * Listens in the capture phase too — the scroller may be an ancestor element
 * whose scroll events never reach `window`.
 */
export function useBandIndex(attr: string): number {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let observer: IntersectionObserver | null = null;

    const pick = () => {
      const next = resolveIndex(attr);
      if (next !== null) setIndex((prev) => (prev === next ? prev : next));
    };

    // observe() is idempotent per element, so re-observing on every tick is
    // cheaper than tracking which nodes have been replaced
    const observeRows = () => {
      if (!observer) return;
      document.querySelectorAll(`[${attr}]`).forEach((el) => observer!.observe(el));
    };

    observer = new IntersectionObserver(pick, {
      rootMargin: "-45% 0px -45% 0px",
      threshold: 0,
    });

    observeRows();
    pick();

    document.addEventListener("scroll", pick, { passive: true, capture: true });
    window.addEventListener("scroll", pick, { passive: true });
    window.addEventListener("resize", pick);

    return () => {
      document.removeEventListener("scroll", pick, { capture: true });
      window.removeEventListener("scroll", pick);
      window.removeEventListener("resize", pick);
      observer?.disconnect();
    };
  }, [attr]);

  return index;
}

/** `true` once the viewport is narrower than the design's stacked breakpoint. */
export function useNarrow(): boolean {
  // starts false so the server and first client render agree
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT - 1}px)`);
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return narrow;
}

/** Fires once, the first time the element is meaningfully on screen. */
export function useRevealed<T extends HTMLElement>(threshold = 0.12) {
  const ref = useRef<T | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setRevealed(true);
            io.disconnect();
          }
        });
      },
      { threshold },
    );

    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);

  return { ref, revealed };
}
