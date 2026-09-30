// ─── Sharp canvases on high-density screens ───────────────────────────────────────────
// A canvas's width/height attributes set its bitmap; CSS sets how big it is shown. On a
// 2x or 3x phone a 130px bitmap is stretched and looks blurry, especially text. So the
// bitmap is made dpr times larger and the context is scaled to match; callers keep
// drawing in CSS pixels. Chart.js already does this; this is for the hand-drawn
// canvases. Capped at 3 (memory grows with the square of the ratio).

export const MAX_DPR = 3;

export function canvasDpr(): number {
  const raw = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.min(Math.max(raw, 1), MAX_DPR);
}

/**
 * Size `canvas` for the current display and return a context that draws in CSS pixels.
 * Pass the size it occupies on screen, in CSS pixels. Returns null when there is no 2D
 * context, like getContext, so the existing `if (!ctx) return;` checks still work.
 */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const dpr = canvasDpr();
  const w = Math.max(1, Math.round(cssWidth * dpr));
  const h = Math.max(1, Math.round(cssHeight * dpr));

  // Setting width/height clears the canvas and its state, so only do it when the size
  // changed.
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  // Set rather than multiply: a redraw that skipped the resize above still holds the
  // previous transform, and `scale()` would compound it on every frame.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
