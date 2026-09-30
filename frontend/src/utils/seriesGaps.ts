// ─── Where did the data stop? ──────────────────────────────────────────────────
// A line drawn straight across a five-day outage looks the same as five calm minutes.
// This finds the breaks so charts can lift the pen: Chart.js breaks a line at `null`, an
// SVG path with a new `M`. Both use the same rule. No imports.

/** A gap is any interval longer than this many times the series' usual spacing. */
export const DEFAULT_GAP_FACTOR = 2.5;

/**
 * How many neighbouring intervals define the usual spacing at a point.
 *
 * Spacing is judged locally, not once for the whole series, because live charts join
 * aggregated history with raw live readings at very different rates:
 *
 *   Environment  -1h history = one point per minute, live ESP32 readings every ~3s.
 *   ServerFocus  -24h history = one point per 10 minutes, live agent posts every 10s.
 *
 * A single median over both flips once the live part outnumbers the history, and then
 * every normal history interval looks like a gap. Comparing each interval with its own
 * neighbourhood avoids that. Eight on each side is enough to ignore a few outliers.
 */
export const LOCAL_WINDOW = 8;

/** Median of a list of intervals. Copies before sorting — callers reuse their arrays. */
function median(values: number[]): number {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

/** Positive intervals in `deltas[from..to)`, clamped to the array. */
function slicePositive(deltas: number[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i < Math.min(deltas.length, to); i++) {
    if (deltas[i]! > 0) out.push(deltas[i]!);
  }
  return out;
}

/**
 * The series' usual spacing overall: the median interval (a mean would be pulled up by
 * the very gap we are looking for). Only valid for a single-rate series; `gapIndices`
 * uses it as a fallback for series too short to have a neighbourhood. Returns 0 for a
 * series too short to have a spacing.
 */
export function medianStep(times: number[]): number {
  if (!times || times.length < 2) return 0;
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i]! - times[i - 1]!;
    if (d > 0) deltas.push(d);
  }
  return median(deltas);
}

/**
 * Indices where a gap comes before the point (break the line before index i).
 *
 * Each interval is compared with the spacing around it. The expected spacing is the
 * larger of the two sides' medians, so the switch from history to live data is not seen
 * as an outage, while a real dropout is still caught at `factor` x the local rate.
 *
 * `factor` is above 2 because one empty bucket in the aggregated history already
 * doubles the spacing; 2.5 ignores that and still catches real gaps. `minMs` lets a
 * caller ignore short gaps on fast live series.
 */
export function gapIndices(
  times: number[],
  {
    factor = DEFAULT_GAP_FACTOR,
    minMs = 0,
    window = LOCAL_WINDOW,
  }: { factor?: number; minMs?: number; window?: number } = {},
): Set<number> {
  const out = new Set<number>();
  if (!times || times.length < 2) return out;

  // deltas[i] is the interval ending at point i+1, so a flagged deltas[i] breaks the
  // line before index i+1 — the same convention the return value has always used.
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) deltas.push(times[i]! - times[i - 1]!);

  // Fallback for a series with no neighbourhood to speak of (2-3 points): one interval
  // cannot be judged against its neighbours, so the global figure is all there is.
  const globalStep = median(deltas.filter((d) => d > 0));
  if (!globalStep) return out;

  const w = Math.max(1, Math.floor(window));
  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i]!;
    if (d <= 0) continue;
    // Self excluded from both windows: an outage must never be allowed to widen the very
    // expectation it is being tested against.
    const before = median(slicePositive(deltas, i - w, i));
    const after = median(slicePositive(deltas, i + 1, i + 1 + w));
    const expected = Math.max(before, after) || globalStep;
    if (d > Math.max(expected * factor, minMs)) out.add(i + 1);
  }
  return out;
}

/**
 * Rebuild a chart's arrays with a break at every gap. The x-axis is a category axis, so
 * a break needs a slot in the labels and every dataset; a null value alone would shift
 * later points left.
 *
 * @param times    the points' timestamps, used only to find the gaps
 * @param labels   the x-axis label for each point
 * @param series   one or more parallel value arrays (cpu, memory, disk, …)
 * @returns the same shape, with a blank label + null value at each break
 */
export function withGaps(
  times: number[],
  labels: string[],
  series: (number | null)[][],
  opts?: { factor?: number; minMs?: number },
): { labels: string[]; series: (number | null)[][]; gapCount: number } {
  const gaps = gapIndices(times, opts);
  if (gaps.size === 0) return { labels, series, gapCount: 0 };

  const outLabels: string[] = [];
  const outSeries: (number | null)[][] = series.map(() => []);
  for (let i = 0; i < labels.length; i++) {
    if (gaps.has(i)) {
      // The break itself. An empty label keeps the axis honest — there is no reading
      // here to name, and inventing a timestamp would imply one.
      outLabels.push("");
      for (const s of outSeries) s.push(null);
    }
    outLabels.push(labels[i] ?? "");
    for (let k = 0; k < series.length; k++) outSeries[k]!.push(series[k]![i] ?? null);
  }
  return { labels: outLabels, series: outSeries, gapCount: gaps.size };
}

/** An SVG path `d` that lifts the pen at each gap (one `d` can hold several `M` subpaths). */
export function pathWithGaps(
  points: { t: number; x: number; y: number }[],
  opts?: { factor?: number; minMs?: number },
): string {
  if (!points.length) return "";
  const gaps = gapIndices(points.map((p) => p.t), opts);
  return points
    .map((p, i) => {
      const cmd = i === 0 || gaps.has(i) ? "M" : "L";
      return `${cmd}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(" ");
}

export default { medianStep, gapIndices, withGaps, pathWithGaps, DEFAULT_GAP_FACTOR };
