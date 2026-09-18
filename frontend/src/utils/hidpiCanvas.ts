// ─── Canvas that is sharp on a phone ───────────────────────────────────────────
//
// A <canvas> has TWO sizes and they are not the same thing: the `width`/`height`
// ATTRIBUTES are the bitmap it draws into, while CSS decides how big that bitmap is
// stretched on screen. Give it `width={130}` and `style={{ width: "100%" }}` and you
// have asked the browser to blow a 130-pixel image up to whatever the layout says.
//
// On a desktop at devicePixelRatio 1 the two happen to agree, so it looks perfect. A
// phone is 2x or 3x, so the same 130-pixel bitmap is scaled across 260-390 physical
// pixels and every edge softens — worst on TEXT, which is why the gauge reading and its
// unit (`%`, `°C`, `ppm`) looked fuzzier than the arc around them. That is also why this
// only ever showed up on mobile.
//
// The fix is to make the bitmap dpr times bigger and then scale the drawing context by
// the same factor, so every call site keeps working in CSS pixels and none of the
// geometry maths has to change.
//
// Chart.js already does this for itself, so the Chart-backed sparklines were never
// affected — only the hand-drawn canvases.
//
// ⚠️ Capped at 3. Beyond that the memory cost grows with the SQUARE of the ratio for
// differences no eye resolves, and some Android browsers report 4+.

export const MAX_DPR = 3;

export function canvasDpr(): number {
  const raw = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.min(Math.max(raw, 1), MAX_DPR);
}

/**
 * Size `canvas` for the current display and return a context that draws in CSS pixels.
 *
 * Pass the size the canvas OCCUPIES on screen, in CSS pixels. Everything after this call
 * — coordinates, radii, line widths, font sizes — stays in those same units.
 *
 * Returns null when 2D context is unavailable, matching what `getContext` does, so the
 * existing `if (!ctx) return;` guard at every call site still covers it.
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

  // Assigning width/height RESETS the bitmap and the whole context state, so it is only
  // done when the size actually changed — otherwise every redraw would throw away the
  // previous frame for nothing.
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  // Set rather than multiply: a redraw that skipped the resize above still holds the
  // previous transform, and `scale()` would compound it on every frame.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
