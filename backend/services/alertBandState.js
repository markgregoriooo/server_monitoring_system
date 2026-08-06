// ─── Shared in-memory "current severity band" per (device, metric) ──────────────
// Used by the alert TRIGGER sites (agentService.checkThresholds + handlers/sensorHandler)
// and re-armed by the alert LIFECYCLE (alertsService.resolve / autoResolveMetric).
//
// Why it's centralized: alerts are only raised on the ONSET of a worse band (an
// escalation) — a metric sitting at "critical" doesn't re-fire every poll. That band
// used to live privately inside each trigger module, so resolving an alert couldn't
// re-arm the detector: a metric that stayed breaching after a manual resolve would
// never re-alert. Holding it here lets resolve() reset the band to "normal", so a
// still-true condition re-escalates and re-alerts on the next reading (the way
// PagerDuty/Opsgenie re-open an incident whose source is still firing).
//
// Key = `${deviceId ?? "room"}:${metric}`. deviceId is null for room-level environment
// metrics (temperature/gas/humidity); a real id for server metrics (cpu/mem/disk).
// A missing key means "normal" (the default), so this never needs seeding.

const DEFAULT_BAND = "normal";
const bands = new Map(); // key -> "normal" | "info" | "warning" | "critical"
const streaks = new Map(); // key -> consecutive "normal" readings seen so far

function key(deviceId, metric) {
  return `${deviceId ?? "room"}:${metric}`;
}

// ─── Recovery confirmation ──────────────────────────────────────────────────────
// A SINGLE normal reading is weak evidence: it can be a dip in a metric oscillating
// around its threshold. Callers require N consecutive normals before treating a
// metric as recovered, and hold the previous band meanwhile.
//
// Why it's needed: the DB cooldown can't damp an oscillation on its own, because a
// RESOLVED alert deliberately stops suppressing (so genuine recurrences re-alert).
// Without confirmation, a value flapping across its threshold would auto-resolve and
// re-alert on every swing — a storm of alerts and emails for one unstable device.
// Escalation is unaffected and still instant; this only delays the all-clear.
//
// ALERT_RECOVERY_SAMPLES (blank = 3). Cadence differs per source, so the same count
// means different wall-clock: ~30s for Go agents (~10s/sample), ~9s for the ESP32
// (~3s/sample). Read lazily so this module stays import-free.
let _samples = null;
function recoverySamples() {
  if (_samples === null) _samples = Math.max(1, Number(process.env.ALERT_RECOVERY_SAMPLES) || 3);
  return _samples;
}

// Count one normal reading. Returns true when recovery is CONFIRMED (streak reached,
// counter cleared); false means "hold the previous band, not convinced yet".
function confirmRecovery(deviceId, metric) {
  const k = key(deviceId, metric);
  const n = (streaks.get(k) ?? 0) + 1;
  if (n < recoverySamples()) {
    streaks.set(k, n);
    return false;
  }
  streaks.delete(k);
  return true;
}

// A breaching reading breaks the run of normals.
function breakRecovery(deviceId, metric) {
  streaks.delete(key(deviceId, metric));
}

function getBand(deviceId, metric) {
  return bands.get(key(deviceId, metric)) ?? DEFAULT_BAND;
}

function setBand(deviceId, metric, band) {
  bands.set(key(deviceId, metric), band ?? DEFAULT_BAND);
}

// Re-arm one (device, metric) so the next breaching reading counts as a fresh
// escalation. Called when an alert is resolved (manual or auto).
function resetBand(deviceId, metric) {
  bands.delete(key(deviceId, metric));
  streaks.delete(key(deviceId, metric)); // a stale streak must not survive a re-arm
}

// Re-arm every metric for a device — used on reject / offline / remove so a server
// re-alerts cleanly when it returns. Trailing ":" makes the prefix unambiguous
// ("1:" never matches "12:cpu").
function resetDevice(deviceId) {
  const prefix = `${deviceId ?? "room"}:`;
  for (const k of bands.keys()) if (k.startsWith(prefix)) bands.delete(k);
  for (const k of streaks.keys()) if (k.startsWith(prefix)) streaks.delete(k);
}

export default {
  getBand, setBand, resetBand, resetDevice, DEFAULT_BAND,
  confirmRecovery, breakRecovery,
};
