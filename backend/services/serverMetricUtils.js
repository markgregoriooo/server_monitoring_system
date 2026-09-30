// ─── Helpers for the server-metric path ──────────────────────────────────
// No imports, so the tests can check the metric contract and the offline-window math
// without MySQL or InfluxDB. Used by handlers/serverMetricsHandler.js and
// services/agentService.js.

// Float fields every metric POST must have (process_count is checked separately as
// an integer). Must match the Go agent's ServerMetrics struct
// (agent/internal/collector/metrics.go); tests/contract.test.js fails if they differ.
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

// Maximum volumes accepted per post. The agent already caps at 16; this is the
// server-side limit so a bad request cannot create hundreds of points.
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

// How long a server may be silent before it counts as offline: three missed posts
// (one lost POST is not an outage), with a minimum. Sized per agent, so a
// `-interval 60` agent does not flap.
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

// Normalise the optional `volumes` array. A bad entry is dropped instead of
// rejecting the whole post (the agent also skips volumes it cannot read). The core
// metric fields stay strict.
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

// Check one sample's required fields. Returns an error string, or null when valid.
// Used by both the live POST and the backfill batch.
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

// Oldest backfill accepted. Buffered samples use the agent's clock, so they are
// limited in case a host's clock is far off.
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

// ─── Heartbeat + shutdown notice ──────────────────────────────────────────────
// Metric posts are too heavy to send every couple of seconds, so agents also send an
// empty heartbeat every 2s so a dead server is noticed quickly, and a shutdown notice
// when stopping, so a clean shutdown is known right away.

// Silence after which a heartbeating agent's server counts as offline. Three missed
// beats at the agent's 2s cadence — one lost beat on a flaky link is not an outage.
export const HEARTBEAT_TIMEOUT_SEC = Math.max(3, Number(process.env.SERVER_HEARTBEAT_TIMEOUT_SEC) || 6);

// After a shutdown notice, ignore liveness from that server for this long. On Windows
// the notice comes from a separate task while the agent may still post, and a late
// post would mark the server Online again and resolve the alert just raised.
export const SHUTDOWN_HOLD_SEC = Math.max(5, Number(process.env.SERVER_SHUTDOWN_HOLD_SEC) || 30);

// Ids whose last heartbeat is older than the timeout. `beats` is Map<id, lastBeatMs>.
// Only servers that have sent a heartbeat are in the map; older agents are left to
// the metric-window sweep.
export function staleBeats(beats, nowMs, timeoutMs = HEARTBEAT_TIMEOUT_SEC * 1000) {
  const out = [];
  for (const [id, at] of beats) if (nowMs - at > timeoutMs) out.push(id);
  return out;
}

// True while a server is inside the hold window after its shutdown notice.
export function inShutdownHold(noticeAtMs, nowMs, holdMs = SHUTDOWN_HOLD_SEC * 1000) {
  return Number.isFinite(noticeAtMs) && nowMs - noticeAtMs >= 0 && nowMs - noticeAtMs < holdMs;
}

// What the agent says is happening. Anything unrecognised is treated as "stopped" —
// the agent is going away for a reason we cannot name, which is still worth a page.
export const SHUTDOWN_REASONS = {
  shutdown: { title: "Server shutting down", verb: "is shutting down or restarting", severity: "critical" },
  stopped: { title: "Monitoring agent stopped", verb: "stopped its monitoring agent", severity: "critical" },
};
export function shutdownReason(raw) {
  return raw === "shutdown" ? "shutdown" : "stopped";
}
