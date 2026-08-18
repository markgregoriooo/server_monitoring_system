// ─── Pure helpers for the server-metric path ──────────────────────────────────
// Deliberately free of imports (no DB, no InfluxDB, no env-dependent clients) so
// the test suite can exercise the contract and the offline-window maths without a
// running MySQL/InfluxDB. Both handlers/serverMetricsHandler.js and
// services/agentService.js import from here.

// Float fields every metric POST must carry. process_count is validated
// separately as an integer. Keep this list in sync with the Go agent's
// ServerMetrics struct (agent/internal/collector/metrics.go) — tests/contract.test.js
// parses that file and fails if the two drift.
export const NUMERIC_FIELDS = [
  "cpu_percent",
  "mem_used_mb",
  "mem_total_mb",
  "mem_percent",
  "disk_used_gb",
  "disk_total_gb",
  "disk_percent",
  "net_bytes_sent",
  "net_bytes_recv",
  "uptime_seconds",
];

// Upper bound on volumes accepted per post. The agent already caps at 16; this
// is the server-side guard so a malformed/hostile body can't fan out into
// hundreds of Influx points per 10s post.
export const MAX_VOLUMES = 32;
export const MAX_MOUNT_LEN = 120; // mount is an Influx TAG — keep cardinality sane

// What the agent posts at when it doesn't say otherwise (its own flag default).
export const DEFAULT_INTERVAL_SEC = 10;

// Never call a server offline sooner than this, however fast it posts — a 1s
// agent shouldn't get a 3s grace period. Tunable for slow/lossy links.
export const OFFLINE_FLOOR_SEC = Number(process.env.SERVER_OFFLINE_AFTER_SEC) || 30;

// Widest window we'll wait before declaring a server down, so a nonsense interval
// can't effectively disable offline detection.
export const OFFLINE_CEILING_SEC = 3600;

// How long a server may go silent before it counts as offline. Three missed posts
// is the tolerance (one dropped POST must not raise a false alarm), floored so
// fast agents don't get a hair trigger.
//
// This used to be a flat 30s while the agent's interval was a settable flag, so
// installing with `-interval 60` flapped the server Offline/Online forever.
export function offlineWindowSec(intervalSec) {
  const n = Number(intervalSec);
  const interval = Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_SEC;
  return Math.min(OFFLINE_CEILING_SEC, Math.max(OFFLINE_FLOOR_SEC, Math.round(interval * 3)));
}

// Accept only a sane posting cadence from the agent; anything else falls back to
// the default rather than poisoning the offline window.
export function sanitizeInterval(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 3600) return null;
  return Math.round(n);
}

// Normalize the optional `volumes` array. Deliberately lenient: a single bad
// entry is dropped rather than 400-ing the whole post, matching the agent's own
// "a volume that fails to probe is skipped" behaviour. The core metric fields
// stay strict — those indicate real contract drift.
export function sanitizeVolumes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    if (out.length >= MAX_VOLUMES) break;
    const mount = typeof v?.mount === "string" ? v.mount.trim() : "";
    if (!mount || mount.length > MAX_MOUNT_LEN || seen.has(mount)) continue;

    const nums = [v.total_gb, v.used_gb, v.percent];
    if (nums.some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0)) continue;
    if (v.percent > 100) continue;

    seen.add(mount);
    out.push({
      mount,
      fstype: typeof v.fstype === "string" ? v.fstype.slice(0, 40) : "",
      total_gb: v.total_gb,
      used_gb: v.used_gb,
      percent: v.percent,
    });
  }
  return out;
}

export function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Validate one metric sample's required fields. Returns an error string, or null
// when the sample is well-formed. Shared by the live POST and the backfill batch
// so a buffered sample can never enter by a laxer door than a live one.
export function validateSample(data) {
  for (const f of NUMERIC_FIELDS) {
    if (typeof data?.[f] !== "number" || !Number.isFinite(data[f])) {
      return `Invalid or missing field: ${f}`;
    }
  }
  if (!Number.isInteger(data.process_count)) {
    return "Invalid or missing field: process_count";
  }
  return null;
}

// Oldest backfill we'll accept. A buffered sample carries the agent's own clock
// (the only path where we trust it), so it must be clamped: a host with a wildly
// wrong RTC could otherwise write points years into the past or the future.
export const MAX_BACKFILL_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Resolve a buffered sample's timestamp. Returns null when it's unusable, so the
// caller can fall back to "now" rather than writing a bogus point.
export function backfillTimestamp(collectedAt, now = Date.now()) {
  if (typeof collectedAt !== "string" || !collectedAt) return null;
  const t = Date.parse(collectedAt);
  if (!Number.isFinite(t)) return null;
  if (t > now + 60_000) return null; // clock ahead of us — don't write the future
  if (t < now - MAX_BACKFILL_AGE_MS) return null; // older than we retain
  return new Date(t);
}
