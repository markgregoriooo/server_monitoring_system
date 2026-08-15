// ─── Where did the data stop? ──────────────────────────────────────────────────
//
// Every chart in this app plots points in order and joins them with a line, which
// silently asserts something the data does not: that the two ends of a straight segment
// are a few seconds apart. When a sensor is down for five days, that segment is drawn
// exactly like a calm five minutes — the outage becomes the least visible thing on a
// page whose whole job is to show it.
//
// This finds those breaks so a chart can lift the pen instead. Chart.js breaks a line at
// a `null` value; an SVG path breaks by starting a new `M` subpath. Both are driven from
// the same rule here, so "the line stopped" means the same thing on every page.
//
// PURE and import-free, like utils/envThresholds and utils/tempZone.

/** A gap is any interval longer than this many times the series' usual spacing. */
export const DEFAULT_GAP_FACTOR = 2.5;

/**
 * The series' usual spacing — the MEDIAN interval, not the mean.
 *
 * Median because one long outage would drag a mean far enough to hide itself: the gap
 * we are trying to detect would redefine "normal" and then fail its own test. The median
 * is unmoved by a handful of large intervals, which is exactly the property needed here.
 *
 * Returns 0 for a series too short to have a spacing.
 */
export function medianStep(times: number[]): number {
  if (!times || times.length < 2) return 0;
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i]! - times[i - 1]!;
    if (d > 0) deltas.push(d);
  }
  if (!deltas.length) return 0;
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  return deltas.length % 2 ? deltas[mid]! : (deltas[mid - 1]! + deltas[mid]!) / 2;
}

/**
 * Indices where a gap PRECEDES the point — i.e. the line should be broken before
 * drawing index i.
 *
 * `factor` is deliberately above 2: with server-side `aggregateWindow(createEmpty:false)`
 * a single empty bucket already doubles the spacing, and one missing bucket is sampling
 * noise rather than an outage. 2.5 ignores that and still catches anything real.
 *
 * `minMs` lets a caller refuse to call anything under some duration a gap, for fast live
 * series where a couple of dropped frames mean nothing.
 */
export function gapIndices(
  times: number[],
  { factor = DEFAULT_GAP_FACTOR, minMs = 0 }: { factor?: number; minMs?: number } = {},
): Set<number> {
  const out = new Set<number>();
  const step = medianStep(times);
  if (!step) return out;
  const threshold = Math.max(step * factor, minMs);
  for (let i = 1; i < times.length; i++) {
    if (times[i]! - times[i - 1]! > threshold) out.add(i);
  }
  return out;
}

/**
 * Rebuild a chart's parallel arrays with a break inserted at every gap.
 *
 * Chart.js here uses a CATEGORY x-axis of preformatted label strings, so a break needs a
 * slot in BOTH the labels and every dataset — pushing a `null` value alone would shift
 * every later point one position left along the axis.
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

/**
 * An SVG path `d` that lifts the pen at each gap.
 *
 * A single `d` may contain several `M` subpaths, so one attribute still draws a broken
 * line — no need for the caller to render a path per segment.
 */
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
