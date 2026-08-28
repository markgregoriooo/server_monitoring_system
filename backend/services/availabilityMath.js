// ─── Availability arithmetic — PURE, import-free ─────────────────────────────
//
// Turns a list of outage records into the four figures ICTU asked a Server
// Availability Report to carry: uptime, downtime, percentage, incidents.
//
// Import-free on purpose, like serverMetricUtils / historyRange / analyticsMath,
// so `npm test` exercises it with no MySQL, no InfluxDB and no .env.
//
// ⚠️ The source is the `alerts` table, NOT the agent's `uptime_seconds`.
// `uptime_seconds` is a host counter that resets to zero on every reboot, so it
// answers "how long has this box been up SINCE it last booted" — a sawtooth. An
// availability report asks the opposite question: what share of THIS PERIOD was
// the server reachable, across however many reboots. Only the offline alert
// record spans reboots, because it is written from the backend's side of the
// connection. See agentService.recordHeartbeat, which auto-resolves the open
// `offline` alert on the offline→online transition — that resolution is what
// closes an outage interval here.
//
// Servers parked for planned downtime never enter this at all: `setMaintenance`
// makes the offline sweep skip them, so no alert is raised and the window is not
// counted against availability. That is deliberate — planned work is not an
// outage — and it means the figure below is UNPLANNED availability.

/** One second, in ms. */
const SEC = 1000;

/**
 * Clamp one outage to the reporting window.
 *
 * Returns null when the outage does not overlap the window at all, so callers can
 * filter in one pass. An outage that began before the window contributes only its
 * overlap: a server down since last month is not a month of this month's downtime.
 *
 * @param {number} startMs outage start
 * @param {number} endMs   outage end (already resolved to a number by the caller)
 * @param {number} winStart window start
 * @param {number} winEnd   window end
 * @returns {{start: number, end: number} | null}
 */
export function clampInterval(startMs, endMs, winStart, winEnd) {
  if (![startMs, endMs, winStart, winEnd].every(Number.isFinite)) return null;
  const start = Math.max(startMs, winStart);
  const end = Math.min(endMs, winEnd);
  // `<=` not `<`: a zero-length overlap is not downtime, and letting it through
  // would inflate the incident count with outages that touch the boundary only.
  return end <= start ? null : { start, end };
}

/**
 * Merge overlapping or touching intervals into distinct outage windows.
 *
 * Two reasons this is not optional:
 *
 *  1. Summing raw intervals DOUBLE-COUNTS any overlap, and enough overlap makes
 *     downtime exceed the period — which yields a negative uptime and an
 *     availability above 100% or below 0%. A report that can print "-3%" is worse
 *     than no report.
 *  2. Two alerts overlapping in time are ONE outage to whoever reads the page.
 *     Incidents are counted off the merged set for exactly that reason, so the
 *     incident count and the downtime figure describe the same object.
 *
 * Overlap is tested with `<=` so intervals that merely touch (one resolves at the
 * instant the next opens) fuse into one window rather than reading as two.
 *
 * @param {{start: number, end: number}[]} intervals
 * @returns {{start: number, end: number}[]} sorted, non-overlapping
 */
export function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ start: iv.start, end: iv.end });
  }
  return out;
}

/**
 * Human-readable duration. Compact by design — this lands in a table cell.
 *
 * The rule is positional rather than "drop every zero", so the same duration always
 * renders the same width and a reader can compare two cells down a column:
 *
 *   under a minute → "45s"   (seconds are the only thing left to say)
 *   under an hour  → "12m"
 *   under a day    → "4h 12m"
 *   a day or more  → "29d 4h 12m"
 *
 * Dropping interior zeros instead would render exactly one day as "1d", which reads
 * as a truncation next to a neighbouring "1d 3h 20m".
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Compute availability over a window.
 *
 * @param {object} args
 * @param {Date|number|string} args.periodStart
 * @param {Date|number|string} args.periodEnd
 * @param {{ createdAt: Date|number|string, resolvedAt: Date|number|string|null }[]} args.outages
 *   One entry per offline alert. `resolvedAt: null` = still open.
 * @param {Date|number|string} [args.now] injectable clock (tests, and the open-outage cap)
 * @returns {{
 *   periodSec: number, downtimeSec: number, uptimeSec: number,
 *   availabilityPct: number|null, incidents: number,
 *   windows: {start: number, end: number}[]
 * }}
 */
export function computeAvailability({ periodStart, periodEnd, outages = [], now = Date.now() }) {
  const ms = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());
  const winStart = ms(periodStart);
  const nowMs = ms(now);

  // The denominator is the ELAPSED part of the window, not the requested one.
  //
  // An open outage can only be counted up to `now` — there is no evidence about a
  // future it hasn't reached. If the denominator still ran to a periodEnd in the
  // future, that bounded downtime would be divided by an unbounded period and the
  // percentage would drift toward 100% purely because the report was run early.
  // Both sides are therefore capped at the same instant.
  const winEnd = Math.min(ms(periodEnd), nowMs);

  const periodMs = winEnd - winStart;
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    return {
      periodSec: 0, downtimeSec: 0, uptimeSec: 0,
      availabilityPct: null, incidents: 0, windows: [],
    };
  }

  const clamped = [];
  for (const o of outages) {
    const start = ms(o.createdAt);
    // An unresolved alert is still running: it ends at the edge of what we know.
    const end = o.resolvedAt == null ? winEnd : ms(o.resolvedAt);
    const iv = clampInterval(start, end, winStart, winEnd);
    if (iv) clamped.push(iv);
  }

  const windows = mergeIntervals(clamped);
  const downtimeMs = windows.reduce((sum, w) => sum + (w.end - w.start), 0);
  const uptimeMs = Math.max(0, periodMs - downtimeMs);

  let availabilityPct = +((uptimeMs / periodMs) * 100).toFixed(2);
  // Never let a real outage round away to a clean 100%. A brief blip on a 30-day
  // window is ~99.998%, which two decimals happily prints as "100" — and "100%"
  // next to a non-zero downtime column is the kind of contradiction a panel or an
  // auditor stops on. Floor it just below instead.
  if (availabilityPct >= 100 && downtimeMs > 0) availabilityPct = 99.99;

  return {
    periodSec: Math.round(periodMs / SEC),
    downtimeSec: Math.round(downtimeMs / SEC),
    uptimeSec: Math.round(uptimeMs / SEC),
    availabilityPct,
    incidents: windows.length,
    windows,
  };
}

export default { clampInterval, mergeIntervals, formatDuration, computeAvailability };
