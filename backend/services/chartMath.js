// ─── Chart geometry ──────────────────────────────────────
// The math behind the report charts, kept apart from pdfkit so it can be unit-tested.
// reportChart.js only draws what these return.

/**
 * A round axis maximum: the next 1 / 2 / 2.5 / 5 x 10^n above the data, so the top
 * point is not on the frame and gridlines are round numbers.
 *
 * @param {number} max largest value in the data
 * @returns {number} an axis top >= max, always > 0
 */
export function niceMax(max) {
  const m = Number(max);
  if (!Number.isFinite(m) || m <= 0) return 1;
  const exp = Math.floor(Math.log10(m));
  const pow = 10 ** exp;
  const frac = m / pow;
  const step = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return +(step * pow).toPrecision(12);
}

/**
 * Gridline values from 0 to `top`, inclusive of both ends.
 *
 * @param {number} top axis maximum (from niceMax)
 * @param {number} count number of intervals, not lines
 * @returns {number[]} count + 1 values
 */
export function ticks(top, count = 4) {
  const n = Math.max(1, Math.floor(count));
  const t = Number(top);
  if (!Number.isFinite(t) || t <= 0) return [0, 1];
  return Array.from({ length: n + 1 }, (_, i) => +((t * i) / n).toPrecision(12));
}

/**
 * Format an axis label: 100.0 becomes 100, 12.5 stays 12.5. Fractions are kept
 * (a 2.5 x 10^n top gives lines at 6.25 / 12.5 / 18.75); only values over a
 * thousand are rounded.
 *
 * @param {number} v
 * @returns {string}
 */
export function axisLabel(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  if (Number.isInteger(n)) return String(n);
  if (Math.abs(n) >= 1000) return String(Math.round(n));
  return String(+n.toFixed(2));
}

/**
 * Map a value to a y coordinate in the plot box. PDF y grows downward, so a larger
 * value gets a smaller y.
 *
 * @param {number} value
 * @param {number} top axis maximum
 * @param {number} y0 top edge of the plot box
 * @param {number} h height of the plot box
 * @returns {number}
 */
export function yFor(value, top, y0, h) {
  const t = Number(top) || 1;
  const v = Number(value);
  if (!Number.isFinite(v)) return y0 + h;
  const clamped = Math.max(0, Math.min(t, v));
  return y0 + h - (clamped / t) * h;
}

/**
 * Evenly spaced x positions for `n` points. A single point goes in the middle.
 *
 * @param {number} n
 * @param {number} x0 left edge
 * @param {number} w width
 * @returns {number[]}
 */
export function xPositions(n, x0, w) {
  const count = Math.max(0, Math.floor(n));
  if (count === 0) return [];
  if (count === 1) return [x0 + w / 2];
  return Array.from({ length: count }, (_, i) => x0 + (w * i) / (count - 1));
}

/**
 * Bar geometry for `groups` categories of `perGroup` series each.
 *
 * @returns {{ groupW: number, barW: number, gap: number }}
 */
export function barLayout(groups, perGroup, w) {
  const g = Math.max(1, Math.floor(groups));
  const s = Math.max(1, Math.floor(perGroup));
  const groupW = w / g;
  // A quarter of each slot is breathing room between groups, so adjacent days do not
  // read as one wide bar.
  const gap = groupW * 0.25;
  const barW = Math.max(1, (groupW - gap) / s);
  return { groupW, barW, gap };
}

/**
 * Which points get an x-axis label: at most `maxLabels`, always including the first
 * and last.
 *
 * @param {number} n number of points
 * @param {number} maxLabels
 * @returns {Set<number>}
 */
export function labelIndices(n, maxLabels = 8) {
  const count = Math.max(0, Math.floor(n));
  const cap = Math.max(2, Math.floor(maxLabels));
  if (count === 0) return new Set();
  if (count <= cap) return new Set(Array.from({ length: count }, (_, i) => i));
  const step = Math.ceil((count - 1) / (cap - 1));
  const out = new Set();
  for (let i = 0; i < count; i += step) out.add(i);
  out.add(count - 1);
  return out;
}

/**
 * Split a series into runs of real numbers, so a gap in the data breaks the line
 * instead of being bridged.
 *
 * @param {(number|null|undefined)[]} values
 * @returns {{start: number, values: number[]}[]}
 */
export function segments(values) {
  const out = [];
  let run = null;
  (values ?? []).forEach((v, i) => {
    const ok = typeof v === "number" && Number.isFinite(v);
    if (ok) {
      if (!run) run = { start: i, values: [] };
      run.values.push(v);
    } else if (run) {
      out.push(run);
      run = null;
    }
  });
  if (run) out.push(run);
  return out;
}

export default {
  niceMax,
  ticks,
  axisLabel,
  yFor,
  xPositions,
  barLayout,
  labelIndices,
  segments,
};
