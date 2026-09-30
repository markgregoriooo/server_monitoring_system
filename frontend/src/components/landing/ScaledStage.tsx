import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * Renders a mock UI at a fixed design width and scales it to fit the space given (a
 * narrower design width on phones, see useIsNarrow). Clips its content so a mock
 * never spills over the text next to it. Measurement cases handled below:
 *
 *   1. Width 0 at first measure (parent still laying out): retry on the next frame
 *      instead of giving up.
 *   2. Web font loading later changes the height: ResizeObserver plus
 *      `document.fonts.ready` re-measure.
 *   3. Fractional heights: rounded up, so the last row is not clipped by half a pixel.
 */
export default function ScaledStage({
  children,
  width = 560,
  /** Fixed design height. Omit for content-driven height. */
  height,
  className = "",
}: {
  children: ReactNode;
  width?: number;
  height?: number;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState<number>(1);
  const [boxHeight, setBoxHeight] = useState<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const inner = innerRef.current;
    if (!host || !inner) return;

    let raf = 0;
    let cancelled = false;

    const update = () => {
      if (cancelled) return;
      const available = host.clientWidth;

      // Guard 1: nothing to measure against yet. Retry rather than give up —
      // giving up leaves the mock unscaled at full design width.
      if (!available) {
        raf = requestAnimationFrame(update);
        return;
      }

      const next = available / width;
      const natural = height ?? inner.offsetHeight;
      setScale(next);
      // Guard 3: round up, so a fractional height never clips the last row.
      setBoxHeight(Math.ceil(natural * next));
    };

    // No ResizeObserver: measure once and stop.
    if (typeof ResizeObserver === "undefined") {
      update();
      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
      };
    }

    const ro = new ResizeObserver(update);
    ro.observe(host);
    ro.observe(inner);
    update();

    // Guard 2: re-measure once the webfont has actually swapped in.
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready.then(update).catch(() => {
        /* font loading is best-effort; the observer above still covers it */
      });
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [width, height]);

  return (
    <div
      ref={hostRef}
      className={className}
      style={{
        position: "relative",
        width: "100%",
        // Belt and braces against guard 1: even if the height is never resolved,
        // the host itself can never be wider than its column.
        maxWidth: "100%",
        // `undefined` until the first measurement; the inner box is in normal flow until
        // then, so nothing collapses.
        height: boxHeight ?? undefined,
        overflow: "hidden",
      }}
    >
      <div
        ref={innerRef}
        style={{
          width,
          ...(height != null ? { height } : {}),
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          position: boxHeight != null ? "absolute" : "relative",
          top: 0,
          left: 0,
        }}
      >
        {children}
      </div>
    </div>
  );
}
