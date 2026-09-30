// ─── Current severity band per (device, metric), in memory ──────────────
// Used by every threshold trigger (agentService.checkThresholds, sensorHandler,
// deviceAlerts) and reset by alertsService on resolve. Alerts fire only when a
// metric moves into a worse band, so after a manual resolve the band goes back to
// "normal" and a metric that is still breaching alerts again on the next reading.
//
// Key = `${deviceId ?? "room"}:${metric}`, with a port suffix where needed
// (`link_util:ether3`). A missing key means "normal".

const DEFAULT_BAND = "normal";
const bands = new Map(); // key -> "normal" | "info" | "warning" | "critical"
const streaks = new Map(); // key -> consecutive "normal" readings seen so far

function key(deviceId, metric) {
  return `${deviceId ?? "room"}:${metric}`;
}

// ─── Recovery confirmation ──────────────────────────────────────────────────────
// One normal reading could just be a dip, so a metric needs N normal readings in a
// row before it counts as recovered; until then the previous band is kept. Without
// this a value hovering at its threshold would resolve and re-alert on every swing.
// Escalation is still immediate.
//
// ALERT_RECOVERY_SAMPLES (default 3). In time that is ~30s for a Go agent and ~9s
// for the ESP32. Read lazily so this module has no imports.
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

// Reset every metric for a device (on reject / offline / remove). The trailing ":"
// stops "1:" from matching "12:cpu".
function resetDevice(deviceId) {
  const prefix = `${deviceId ?? "room"}:`;
  for (const k of bands.keys()) if (k.startsWith(prefix)) bands.delete(k);
  for (const k of streaks.keys()) if (k.startsWith(prefix)) streaks.delete(k);
}

// ─── Settling a new reading ─────────────────────────────────────────────────────
// Same order as alertRulesService.SEV_RANK, repeated so this module has no imports.
const RANK = { normal: 0, info: 1, warning: 2, critical: 3 };

// Decide the band to act on for one reading, given the band held so far and the
// band the reading falls in (after alertRulesService.nextBand).
//
// Returns { effective, resolveAbove }:
//   effective     the band to store and compare against for escalation
//   resolveAbove  null, or a band: close every open alert for this metric whose
//                 severity is above it ("normal" = close them all)
//
// Any move down (to normal, or critical to warning) needs the same confirmation.
// Each severity closes when its own condition clears, so memory settling at 88%
// closes the critical alert and keeps the warning one.
function settle(deviceId, metric, prevBand, band) {
  const prev = prevBand ?? DEFAULT_BAND;
  const next = band ?? DEFAULT_BAND;
  if ((RANK[next] ?? 0) < (RANK[prev] ?? 0)) {
    if (confirmRecovery(deviceId, metric)) return { effective: next, resolveAbove: next };
    return { effective: prev, resolveAbove: null }; // not convinced yet — hold
  }
  if (next !== DEFAULT_BAND) breakRecovery(deviceId, metric); // at or above the held band
  return { effective: next, resolveAbove: null };
}

// Which severities outrank `band` — the alerts a confirmed drop to `band` closes.
function severitiesAbove(band) {
  const r = RANK[band] ?? 0;
  return Object.keys(RANK).filter((s) => s !== DEFAULT_BAND && RANK[s] > r);
}

// The most severe of two bands (for seeding from several open alerts on one metric).
function worse(a, b) {
  return (RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a;
}

export default {
  getBand, setBand, resetBand, resetDevice, DEFAULT_BAND,
  confirmRecovery, breakRecovery, settle, severitiesAbove, worse,
};
