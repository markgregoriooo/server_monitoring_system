import { useEffect, useState } from "react";
import type { RefObject } from "react";

// ─── Redraw a canvas when its pixels no longer match the screen ────────
// `fitCanvas` (utils/hidpiCanvas) sizes a canvas for the current display. That goes
// wrong when:
//   • the element's width changes (window resize, sidebar collapse) — only for a
//     `width: 100%` canvas;
//   • the device pixel ratio changes (browser zoom, or moving to a monitor with
//     different scaling). A resize listener misses this, and the canvas goes blurry.
// Returns a counter to add to the drawing effect's dependency array.

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

    // A `dppx` media query matches only one ratio, so it is re-created for the new ratio
    // each time it fires; otherwise only the first zoom step is caught.
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
