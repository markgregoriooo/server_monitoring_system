// ─── Availability arithmetic ─────────────────────────────
// Turns outage records into the Server Availability figures ICTU asked for:
// uptime, downtime, percentage and incidents. No imports, so it is unit-tested.
//
// The source is the offline alerts, not the agent's uptime_seconds (which resets on
// every reboot). The alert is resolved on the offline→online transition, which
// closes the outage. Servers in maintenance raise no offline alert, so this is
// unplanned availability.

/** One second, in ms. */
const SEC = 1000;

/**
 * Clamp one outage to the report window. Returns null when it does not overlap, so
 * an outage that started last month only counts its part inside this window.
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
 * Merge overlapping or touching intervals. Summing overlapping intervals counts
 * downtime twice (and can even give a negative uptime), and two overlapping alerts
 * are one outage to a reader. Incidents are counted from the merged list.
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
 * Short duration for a table cell. Units are dropped from the left only, so values
 * line up down a column:
 *
 *   under a minute → "45s"
 *   under an hour  → "12m"
 *   under a day    → "4h 12m"
 *   a day or more  → "29d 4h 12m"
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

  // Divide by the part of the window that has already passed. An open outage can only
  // be counted up to now, so running a report early would otherwise drift toward 100%.
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
  // Never round a real outage up to 100%: a short blip over 30 days is ~99.998%, and
  // "100%" next to non-zero downtime looks wrong. Cap it just below.
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
