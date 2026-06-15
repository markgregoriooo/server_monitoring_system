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

function key(deviceId, metric) {
  return `${deviceId ?? "room"}:${metric}`;
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
}

// Re-arm every metric for a device — used on reject / offline / remove so a server
// re-alerts cleanly when it returns. Trailing ":" makes the prefix unambiguous
// ("1:" never matches "12:cpu").
function resetDevice(deviceId) {
  const prefix = `${deviceId ?? "room"}:`;
  for (const k of bands.keys()) if (k.startsWith(prefix)) bands.delete(k);
}

export default { getBand, setBand, resetBand, resetDevice, DEFAULT_BAND };
