// Shared formatting helpers — extracted from duplicated definitions across the app.
// See audits/code-duplication-report.md (D-04, D-06) and the 2026-08-25 re-audit
// (R-04: formatUptime had FIVE copies, fmtDateTime four, and two of them disagreed).

import { API_URL } from "../config";

/** Two-letter uppercase initials from a name, e.g. "Mark Angelo" → "MA". */
export function initials(name: string): string {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
}

/** Resolve a stored `profile_image` to a usable <img> src, or null (→ show initials).
 *  - Google/OAuth photos are ABSOLUTE urls (https://lh3.googleusercontent.com/…) → use as-is.
 *  - Uploaded files are server-relative paths (/uploads/…) → prefix with the backend URL.
 *  The old code prefixed everything with API_URL, which broke Google photos. */
export function avatarUrl(profileImage?: string | null): string | null {
  if (!profileImage) return null;
  return /^https?:\/\//i.test(profileImage) ? profileImage : `${API_URL}${profileImage}`;
}

/** Manila wall-clock time, 24-hour. Mirrors the toLocaleTimeString calls used across pages. */
export function manilaTime(d: Date = new Date()): string {
  return d.toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour12: false });
}

/**
 * Network throughput from BYTES per second, scaled to a unit that can show it.
 *
 * A fixed unit cannot: expressed in MB/s, a router moving 40 KB/s reads "0.00 MB/s"
 * while the auto-scaled chart beside it plots a perfectly visible line — the number
 * says idle and the picture says busy, and the number is the one people believe.
 *
 * Reported in BITS per second (hence ×8) because that is the unit link speeds are sold
 * and configured in, so "8 Mb/s" is directly comparable to a port's negotiated 100 Mb/s.
 * Same function the router and MikroTik detail pages have always used — shared here so a
 * given router reads identically on the Dashboard and on its own page.
 */
export function formatBps(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return "—";
  const bits = bytesPerSec * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gb/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(2)} Mb/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(1)} kb/s`;
  return `${Math.round(bits)} b/s`;
}

// ─── Time ─────────────────────────────────────────────────────────────────────

/**
 * Where a chart's x-axis stops being "times today" and starts needing DATES.
 *
 * Was declared in four separate files — twice as `48 * 3600` and twice as
 * `86400 * 2`. Identical numbers, but two spellings of one rule is how the pages
 * drift apart the first time someone tunes one of them.
 */
export const MULTI_DAY_SEC = 48 * 3600;

/** A chart tick: clock time within a short window, month+day+hour across a long one. */
export function fmtAxisTime(iso: string, spanSec: number): string {
  const d = new Date(iso);
  if (spanSec >= MULTI_DAY_SEC) {
    return d.toLocaleString("en-PH", {
      timeZone: "Asia/Manila", month: "short", day: "2-digit", hour: "2-digit", hour12: false,
    });
  }
  return d.toLocaleTimeString("en-PH", {
    timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/** Manila date+time for a log row or a "last seen" stamp. */
export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-PH", {
    timeZone: "Asia/Manila", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/**
 * Uptime in the largest two units that still say something: "12d 4h", "4h 09m", "09m".
 *
 * This existed in FIVE places — MikrotikMonitoring, NetworkMonitoring,
 * MikrotikDetail, NetworkDetail, and `backend/services/serverMetricUtils.js`. The
 * frontend four agreed; the backend one has no null branch because it is only ever
 * handed a number. Kept separate on purpose: that module is deliberately import-free
 * so `backend/tests/` runs with no MySQL/InfluxDB. Change one, check the other.
 */
export function formatUptime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── Rates & link speed ───────────────────────────────────────────────────────

/** A port's NEGOTIATED speed (ifHighSpeed, Mb/s). null when the port reports none. */
export function formatSpeed(mbps: number | null | undefined): string | null {
  if (mbps == null || !Number.isFinite(mbps) || mbps <= 0) return null;
  return mbps >= 1000
    ? `${(mbps / 1000).toFixed(mbps % 1000 === 0 ? 0 : 1)} Gb/s`
    : `${Math.round(mbps)} Mb/s`;
}

/**
 * MB/s between two cumulative counter samples.
 *
 * Only the SERVER path needs this: `server_metrics` stores raw counters, so the rate
 * exists only as a difference. The network endpoint derives its rate server-side
 * (`derivative(nonNegative: true)`) and returns bytes/sec directly.
 *
 * Math.max clamps a counter reset — an agent restart or host reboot — to 0 rather than
 * graphing a large negative spike.
 */
export function rateMBs(curr: number | null, prev: number | null, currT: string, prevT: string): number {
  if (curr == null || prev == null) return 0;
  const dt = (new Date(currT).getTime() - new Date(prevT).getTime()) / 1000;
  if (dt <= 0) return 0;
  return +(Math.max(0, curr - prev) / dt / 1024 / 1024).toFixed(2);
}
