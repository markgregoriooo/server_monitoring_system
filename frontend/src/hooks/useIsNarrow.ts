import { useEffect, useState } from "react";

/**
 * True while the viewport is narrower than `breakpoint`.
 *
 * Lived in `components/landing/motion.ts` until the Settings page needed it too;
 * that module now re-exports this one, so the landing mocks and the app share a
 * single implementation rather than two copies drifting apart.
 *
 * `breakpoint - 0.02` rather than `breakpoint - 1`: a media query is evaluated in
 * CSS pixels, which are fractional on a scaled display, so `max-width: 767px`
 * leaves a dead zone that a viewport of 767.5px falls into — matching neither this
 * nor Tailwind's `md:` (`min-width: 768px`). 0.02 is the same epsilon Tailwind's
 * own `max-*` variants use.
 *
 * ⚠️ This is a VIEWPORT test, not a device or capability test. Use it to decide
 * what fits on the screen; use feature detection (e.g. `pipSupported`) to decide
 * what the browser can actually do. Gating a capability on width hides features
 * from someone who merely made their desktop window small.
 *
 * Defaults to 640 (Tailwind `sm`) for the landing page's existing callers.
 */
export function useIsNarrow(breakpoint = 640): boolean {
  const query = `(max-width: ${breakpoint - 0.02}px)`;
  const [narrow, setNarrow] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia?.(query).matches === true,
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    setNarrow(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return narrow;
}
