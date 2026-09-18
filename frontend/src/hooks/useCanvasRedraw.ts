import { useEffect, useState } from "react";
import type { RefObject } from "react";

// ─── Redraw a hand-drawn canvas when its pixels stop matching the screen ────────
//
// `fitCanvas` (utils/hidpiCanvas) sizes a canvas bitmap for the display it is on. That
// is only correct until one of two things moves, and BOTH are ordinary on a desktop:
//
//   • the element's width changes — the window is resized, the sidebar collapses, a
//     panel reflows. Only matters for a canvas that is `width: 100%`.
//   • the DEVICE PIXEL RATIO changes — browser zoom (Ctrl +/-) changes it, so does
//     dragging the window to a monitor on a different Windows scaling factor.
//
// The second is the one a resize listener misses. A gauge pinned at `maxWidth: 130` keeps
// exactly the same CSS width through a zoom, so nothing resizes — the bitmap is simply
// wrong for the screen now, and the gauge goes soft until something else forces a render.
//
// Returns a counter to drop into the drawing effect's dependency array.

export function useCanvasRedraw(ref: RefObject<HTMLElement | null>): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const bump = () => setTick((t) => t + 1);

    const el = ref.current;
    let ro: ResizeObserver | undefined;
    if (el && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(bump);
      ro.observe(el);
    }

    // A `dppx` query only ever matches ONE ratio, so it cannot be left in place: it is
    // re-armed against the new ratio each time it fires. Without the re-arm this reports
    // the first zoom step and then goes quiet for every one after it.
    let mq: MediaQueryList | null = null;
    const onRatio = () => {
      detach();
      arm();
      bump();
    };
    const arm = () => {
      if (typeof window.matchMedia !== "function") return;
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      // Safari < 14 has no addEventListener on MediaQueryList.
      if (mq.addEventListener) mq.addEventListener("change", onRatio);
      else mq.addListener(onRatio);
    };
    const detach = () => {
      if (!mq) return;
      if (mq.removeEventListener) mq.removeEventListener("change", onRatio);
      else mq.removeListener(onRatio);
      mq = null;
    };
    arm();

    return () => {
      ro?.disconnect();
      detach();
    };
  }, [ref]);

  return tick;
}
