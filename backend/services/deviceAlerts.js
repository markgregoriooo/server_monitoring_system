import alertRulesService from "./alertRulesService.js";
import alertBandState from "./alertBandState.js";
import alertsService from "./alertsService.js";
import notificationService from "./notificationService.js";
import agentService from "./agentService.js";

// ─── Router / UPS threshold alerting (REAL alerts, not just device_logs) ─────────
//
// Brings MikroTik routers, generic SNMP routers and UPS devices up to the same
// alerting model servers (agentService.checkThresholds) and the environment
// (handlers/sensorHandler) already use: evaluate each metric against the
// CONFIGURABLE alert_rules (alertRulesService), track the current severity band per
// (device, metric) in the shared alertBandState, and on the ONSET of a worse band
// raise a real alert (notificationService.raiseAlert → bell + toast + email + the
// Alerts page) AND a device_log. Recovery to "normal" auto-resolves the open alert.
// Hysteresis + the restart-proof DB cooldown are inherited from
// alertRulesService.nextBand / raiseAlert — no per-call tuning here.
//
// This REPLACES the old hardcoded, device-log-only checks that lived in the pollers
// (snmpPollerService.checkRouterThresholds/checkUpsThresholds,
// mikrotikPollerService.checkThresholds), which never reached the alerts pipeline.
//
// metric_name vocabulary (must match the seeded alert_rules + the Alert Rules UI):
//   router_cpu, router_mem, router_clients   (router_metrics, per device)
//   link_util                                (network_traffic, per interface)
//   ups_charge, ups_runtime, ups_load        (ups_metrics, per device)
// Boolean events that aren't numeric thresholds (interface down, UPS on battery) are
// raised directly — like server 'offline' — not via alert_rules.

const SEV_RANK = alertRulesService.SEV_RANK;
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? NaN : Number(v));

// Interfaces seen at least once. A link already DOWN when the poller first starts
// establishes a baseline instead of alerting out of the blue (matches the old
// behavior); a genuine up→down transition still alerts.
const seenLink = new Set();

// Previous cumulative error counters per interface, so `link_errors` can alert on the
// RATE of new errors rather than the lifetime total. A router up for a year will have a
// large total that says nothing about current health; errors appearing *now* mean a
// failing cable, dying SFP or duplex mismatch. key `${deviceId}:${ifName}`.
const prevErrors = new Map();

// Errors added since the previous poll, or NaN on the first sighting (no baseline yet,
// so nothing to compare). Counter resets (router reboot) yield 0, not a negative spike.
function errorDelta(deviceId, name, total) {
  if (!Number.isFinite(total)) return NaN;
  const key = `${deviceId}:${name}`;
  const prev = prevErrors.get(key);
  prevErrors.set(key, total);
  if (prev == null) return NaN;
  return total >= prev ? total - prev : 0;
}

// Evaluate one numeric metric against its rules. Returns the device_log row created
// on a fresh escalation (else null). `low` flips the wording for lower-is-worse
// metrics (battery charge / runtime). Mirrors agentService.checkThresholds.
// `iface` narrows rule lookup to one port (link_util / link_errors). Omitted for
// device-level metrics, which resolve per-device then global as before.
async function evalMetric({ deviceId, metricName, type, value, label, unit = "", low = false, iface = null }) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;

  const prevBand = alertBandState.getBand(deviceId, type);
  const rules = await alertRulesService.getEffectiveRules(deviceId, metricName, iface);
  const { band, rule } = alertRulesService.nextBand(rules, value, prevBand);
  alertBandState.setBand(deviceId, type, band); // track always, so a later breach re-arms

  if (band === "normal" && prevBand !== "normal") {
    await alertsService.autoResolveMetric(deviceId, type); // recovered → close open alert
  }
  if (SEV_RANK[band] <= SEV_RANK[prevBand]) return null; // only the ONSET of a worse band

  const shown = Number.isInteger(value) ? `${value}${unit}` : `${Math.round(value)}${unit}`;
  const word = low
    ? band === "critical" ? "critically low" : "low"
    : band === "critical" ? "critical" : "high";
  const message = `${label} ${word}: ${shown}`;

  const log = await agentService.logDevice(deviceId, band, message);
  await notificationService.raiseAlert({
    deviceId, type, severity: band, title: `${label} ${word}`, message,
    metricValue: value, alertRuleId: rule?.alert_rule_id ?? null,
  });
  return log;
}

// Boolean-state event (interface up/down, UPS on/off battery): a real alert on the
// onset, auto-resolve on recovery. `baselineKey` skips the very first observation so
// a condition already true at startup doesn't alert out of the blue (links only).
async function evalEvent({ deviceId, type, active, severity, title, message, baselineKey }) {
  const band = active ? severity : "normal";
  const prevBand = alertBandState.getBand(deviceId, type);
  alertBandState.setBand(deviceId, type, band);

  if (baselineKey && !seenLink.has(baselineKey)) { seenLink.add(baselineKey); return null; }
  if (band === "normal" && prevBand !== "normal") {
    await alertsService.autoResolveMetric(deviceId, type);
    return null;
  }
  if (SEV_RANK[band] <= SEV_RANK[prevBand]) return null;

  const log = await agentService.logDevice(deviceId, severity, message);
  await notificationService.raiseAlert({ deviceId, type, severity, title, message });
  return log;
}

// sample: { cpuPercent, memPercent, connectedClients,
//           interfaces: [{ name, locationLabel, linkUp, utilizationPct }] }
async function checkRouter(io, device, sample) {
  const id = Number(device.id);
  const events = [];

  events.push(await evalMetric({ deviceId: id, metricName: "router_cpu", type: "router_cpu", value: num(sample.cpuPercent), label: "Router CPU", unit: "%" }));
  events.push(await evalMetric({ deviceId: id, metricName: "router_mem", type: "router_mem", value: num(sample.memPercent), label: "Router memory", unit: "%" }));
  events.push(await evalMetric({ deviceId: id, metricName: "router_clients", type: "router_clients", value: num(sample.connectedClients), label: "Connected clients" }));

  for (const i of sample.interfaces ?? []) {
    const ifaceLabel = i.locationLabel ? `${i.name} (${i.locationLabel})` : i.name;
    // Per-interface link saturation — one global `link_util` rule covers every
    // interface; the per-interface `type` keeps each interface's band, alert and
    // auto-resolve independent.
    // `iface` lets a port carry its own threshold — an ISP uplink that normally sits at
    // 70% and an access port that should never exceed 5% can't share one number.
    // Falls back to the device-wide rule, then global, when no per-port rule exists.
    events.push(await evalMetric({
      deviceId: id, metricName: "link_util", type: `link_util:${i.name}`, iface: i.name,
      value: num(i.utilizationPct), label: `Link ${ifaceLabel}`, unit: "%",
    }));
    events.push(await evalEvent({
      deviceId: id, type: `link_down:${i.name}`, active: i.linkUp === false,
      severity: "warning", title: "Interface down",
      message: `Interface ${ifaceLabel} is down`, baselineKey: `${id}:${i.name}`,
    }));

    // Rising rx/tx errors — the classic failing-cable / duplex-mismatch signal. Uses
    // the per-poll DELTA, not the lifetime counter, so a long-running router doesn't
    // sit permanently in alarm over errors from months ago.
    const errDelta = errorDelta(id, i.name, (num(i.rxErrors) || 0) + (num(i.txErrors) || 0));
    events.push(await evalMetric({
      deviceId: id, metricName: "link_errors", type: `link_errors:${i.name}`, iface: i.name,
      value: errDelta, label: `Link ${ifaceLabel} errors`,
    }));
  }

  for (const e of events) if (e) io?.emit("deviceLog", e);
  return events.filter(Boolean);
}

// sample: { batteryChargePct, runtimeRemainingMin, loadPct, onBattery }
async function checkUps(io, device, sample) {
  const id = Number(device.id);
  const events = [];

  // On-battery = mains lost → critical event (not rule-based, like server offline).
  events.push(await evalEvent({
    deviceId: id, type: "ups_on_battery", active: sample.onBattery === true,
    severity: "critical", title: "UPS on battery",
    message: "UPS switched to battery power (mains lost)",
  }));

  events.push(await evalMetric({ deviceId: id, metricName: "ups_charge", type: "ups_charge", value: num(sample.batteryChargePct), label: "UPS battery", unit: "%", low: true }));
  events.push(await evalMetric({ deviceId: id, metricName: "ups_runtime", type: "ups_runtime", value: num(sample.runtimeRemainingMin), label: "UPS runtime", unit: " min", low: true }));
  events.push(await evalMetric({ deviceId: id, metricName: "ups_load", type: "ups_load", value: num(sample.loadPct), label: "UPS load", unit: "%" }));

  for (const e of events) if (e) io?.emit("deviceLog", e);
  return events.filter(Boolean);
}

// Device reachability as a REAL alert (offline = open incident, online = auto-resolve),
// mirroring the server 'offline' pattern. Called from each poller's setReachable ON the
// status transition — the poller already guards on a real change, so this fires once per
// flip; raiseAlert's restart-proof cooldown is a backstop against any repeat. Router /
// MikroTik down is critical (carries campus traffic); a UPS that stops answering is a
// warning. type "device_offline" is distinct from the metric/event types and auto-resolves.
async function checkReachability(device, online, opts = {}) {
  const id = Number(device.id);
  if (online) {
    await alertsService.autoResolveMetric(id, "device_offline");
    return;
  }
  const label =
    opts.label ?? (device.type === "ups" ? "UPS" : device.type === "mikrotik" ? "MikroTik" : "Router");
  const severity = opts.severity ?? (device.type === "ups" ? "warning" : "critical");
  const name = device.name ?? label;
  await notificationService.raiseAlert({
    deviceId: id,
    type: "device_offline",
    severity,
    title: `${label} offline`,
    message: `${label} "${name}" is unreachable.`,
  });
}

export default { checkRouter, checkUps, checkReachability };
