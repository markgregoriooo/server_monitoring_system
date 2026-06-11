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
