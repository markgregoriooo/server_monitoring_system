// Shared formatting helpers. See audits/code-duplication-report.md (D-04, D-06) and the
// 2026-08-25 re-audit (R-04).


/** Two-letter uppercase initials from a name, e.g. "Mark Angelo" → "MA". */
export function initials(name: string): string {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
}

/**
 * Turn a stored `profile_image` into an <img> src, or null (show initials). Absolute
 * URLs only: every avatar is a Google photo, re-synced at each sign-in. An old
 * `/uploads/…` value returns null, since that route was removed (see
 * audits/api-infra-security-2026-08-25.md A-02).
 */
export function avatarUrl(profileImage?: string | null): string | null {
  if (!profileImage) return null;
  return /^https?:\/\//i.test(profileImage) ? profileImage : null;
}

/** Manila wall-clock time, 24-hour. Mirrors the toLocaleTimeString calls used across pages. */
export function manilaTime(d: Date = new Date()): string {
  return d.toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour12: false });
}

/**
 * Network throughput from bytes per second, in a unit that suits the value, so a quiet
 * link does not read "0.00 MB/s". Shown in bits per second (x8), the unit link speeds
 * use, so "8 Mb/s" compares directly with a 100 Mb/s port. Used by the Dashboard and the
 * router/MikroTik pages.
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

/** The range length after which a chart's x-axis shows dates. */
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
 * Uptime in the two largest useful units: "12d 4h", "4h 09m", "09m". The backend has
 * its own copy in serverMetricUtils.js (which must stay import-free for the tests), so
 * change both together.
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
 * MB/s between two cumulative counter samples. Only the server panel needs this; the
 * network endpoint already returns bytes/sec. Math.max turns a counter reset (restart,
 * reboot) into 0 instead of a big negative spike.
 */
export function rateMBs(curr: number | null, prev: number | null, currT: string, prevT: string): number {
  if (curr == null || prev == null) return 0;
  const dt = (new Date(currT).getTime() - new Date(prevT).getTime()) / 1000;
  if (dt <= 0) return 0;
  return +(Math.max(0, curr - prev) / dt / 1024 / 1024).toFixed(2);
}
