import { useCallback, useEffect, useState } from "react";

/**
 * Column layout for a row of `count` equal tiles whose LAST tile may stretch.
 *
 * 1. As many columns as fit at `minWidth` (the most the container can hold).
 * 2. Balanced: the fewest rows that hold them all, then the fewest columns that fill
 *    those rows — seven tiles that fit six-wide become 4 + 3, not 6 + 1.
 * 3. The last tile spans whatever its row leaves empty, so every row ends flush.
 *
 * Pure, so the layout can be reasoned about without a browser.
 */
export function balancedGrid(count: number, maxCols: number): { cols: number; lastSpan: number } {
  const n = Math.max(1, count);
  const fit = Math.max(1, Math.min(n, maxCols));
  const rows = Math.ceil(n / fit);
  const cols = Math.ceil(n / rows);
  // Tiles already on the last tile's row, before it.
  const before = (n - 1) % cols;
  return { cols, lastSpan: cols - before };
}

/**
 * `balancedGrid` driven by the element's real width (ResizeObserver), not the viewport,
 * since the sidebar takes a different share of the screen at each breakpoint.
 */
export function useBalancedGrid(count: number, minWidth: number, gap: number) {
  const [width, setWidth] = useState(0);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const ref = useCallback((node: HTMLElement | null) => setEl(node), []);

  useEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w != null) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);

  // Before the first measurement, assume everything fits on one row.
  const maxCols = width > 0 ? Math.floor((width + gap) / (minWidth + gap)) : count;
  return { ref, ...balancedGrid(count, maxCols) };
}
