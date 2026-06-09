// Shared formatting helpers — extracted from duplicated definitions across the app.
// See audits/code-duplication-report.md (D-04, D-06).

/** Two-letter uppercase initials from a name, e.g. "Mark Angelo" → "MA". */
export function initials(name: string): string {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
}

/** Manila wall-clock time, 24-hour. Mirrors the toLocaleTimeString calls used across pages. */
export function manilaTime(d: Date = new Date()): string {
  return d.toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour12: false });
}
