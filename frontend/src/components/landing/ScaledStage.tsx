import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * Renders a mini-UI mock at a fixed design width and scales it to fit whatever
 * space it is given.
 *
 * The mocks on this page are miniature interfaces — absolutely-positioned
 * toasts, multi-column tile rows, a phone. Reflowing those at every breakpoint
 * would mean a second layout per scene, so instead they are laid out once at a
 * design width (a narrower one on phones, see useIsNarrow) and scaled.
 *
 * This component CLIPS (`overflow: hidden`). That is deliberate — a mock must
 * never spill over the copy beside it — but it makes every measurement bug look
 * identical from the outside: content simply cut off. Three ways that happened,
 * all guarded below:
 *
 *   1. Measured at zero width. If the host is 0px when the observer first runs
 *      (a parent still laying out, a hidden ancestor), the old code returned
 *      early and left `boxHeight` null forever — so the inner box stayed
 *      unscaled at its full design width, overflowing its column and overlapping
 *      whatever sat next to it. It now retries on the next frame instead.
 *   2. Measured before the webfont landed. JetBrains Mono arrives async and has
 *      different metrics to the fallback, so content height changes after first
 *      paint. ResizeObserver catches most of this; `document.fonts.ready` closes
 *      the gap on browsers that batch it differently.
 *   3. Measured to a fraction. A content height of 216.4px scaled by 0.95 gives
 *      205.58, and a wrapper rounded down to 205 clips the last row by half a
 *      pixel — which reads as a cut-off border. Heights round UP.
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

    // Missing ResizeObserver (or a very old browser): measure once and stop. A
    // mock at the wrong size beats one that is absent, and everything it says is
    // repeated in the text beside it.
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
        // `undefined` until the first measurement lands. The inner box is in
        // normal flow at that point, so the wrapper still sizes itself and there
        // is no collapsed frame to see.
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
