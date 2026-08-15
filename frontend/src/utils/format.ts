// Shared formatting helpers — extracted from duplicated definitions across the app.
// See audits/code-duplication-report.md (D-04, D-06).

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
