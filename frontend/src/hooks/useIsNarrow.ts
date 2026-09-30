import { useEffect, useState } from "react";

/**
 * True while the viewport is narrower than `breakpoint`.
 *
 * Uses `breakpoint - 0.02` rather than `- 1`: on a scaled display CSS pixels are
 * fractional, and `max-width: 767px` would miss 767.5px (Tailwind's `max-*` uses the
 * same 0.02). This checks the screen size, not what the browser can do; use feature
 * detection (e.g. `pipSupported`) for that. Default 640 (Tailwind `sm`).
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
