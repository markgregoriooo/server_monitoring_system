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
 * How many neighbouring intervals define "usual spacing" AT a point.
 *
 * ⚠️ Spacing is a LOCAL property here, not one figure for the whole series, and that is
 * the whole point of this module working at all. Every live chart in this app is built
 * the same way: seed from an AGGREGATED history, then append RAW live readings as they
 * arrive. The two halves have completely different cadences —
 *
 *   Environment  -1h history = one point per MINUTE (backend WINDOW_MAP), live ESP32
 *                readings every ~3 SECONDS. A 20x difference.
 *   ServerFocus  -24h history = one point per 10 MINUTES, live agent posts every 10s.
 *
 * — so a single median over the concatenation describes neither half. Worse, it FLIPS:
 * the live tail grows about 20 points a minute, and the moment it out-numbers the
 * history the median collapses from 60 000 ms to 3 000 ms, the threshold with it, and
 * every one of the ~60 perfectly healthy 1-minute history intervals is suddenly "a gap".
 * The line shatters into 60 fragments a few minutes after the page is opened, with no
 * outage anywhere and nothing on screen to explain it. (Verified: 0 breaks for the first
 * ~3 minutes of live streaming, then 59 breaks on the tick the median tips over.)
 *
 * Judging each interval against ITS OWN neighbourhood removes the failure entirely: the
 * history head is measured against minutes, the live tail against seconds, and a real
 * dropout is still several times whatever the local cadence is.
 *
 * Eight either side is enough for the median to shrug off a couple of outliers while
 * staying short enough to turn over quickly at a cadence change.
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
 * The series' usual spacing over the WHOLE series — the MEDIAN interval, not the mean.
 *
 * Median because one long outage would drag a mean far enough to hide itself: the gap
 * we are trying to detect would redefine "normal" and then fail its own test. The median
 * is unmoved by a handful of large intervals, which is exactly the property needed here.
 *
 * ⚠️ Only meaningful for a series with ONE cadence. `gapIndices` uses it purely as the
 * fallback for a series too short to have a neighbourhood — see LOCAL_WINDOW for why a
 * global figure is the wrong instrument on a history+live series.
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
  return median(deltas);
}

/**
 * Indices where a gap PRECEDES the point — i.e. the line should be broken before
 * drawing index i.
 *
 * Each interval is compared against the spacing of its OWN neighbourhood rather than
 * against one figure for the series (see LOCAL_WINDOW). The expected spacing is the
 * LARGER of the two sides' medians, which is what keeps the junction between an
 * aggregated history and a live tail from reading as an outage: the slow side sets the
 * expectation there, so the one long-but-legitimate interval where the cadence changes
 * is never flagged. Inside either half both sides agree, so a real dropout is still
 * caught at `factor` x the cadence actually in force around it.
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
