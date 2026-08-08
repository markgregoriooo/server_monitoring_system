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
// Alerts page) AND a device_log. Recovery to "normal" auto-resolves the open alert,
// but only after ALERT_RECOVERY_SAMPLES consecutive normals (alertBandState.
// confirmRecovery) — the same three-strike all-clear servers and the environment use.
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

// Last seen uptime per device. A router that reports LESS uptime than last poll has
// rebooted — a point-in-time event with no persistent state to auto-resolve, so it is
// raised once per occurrence rather than tracked as a band. key: deviceId.
const prevUptime = new Map();

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

  // Recovery needs CONFIRMATION — one normal sample can be a dip in a metric
  // oscillating around its threshold. Hold the previous band until N consecutive
  // normals (ALERT_RECOVERY_SAMPLES), so a bursty uplink crossing its link_util
  // threshold raises ONE alert instead of an alert/auto-resolve storm. Escalation is
  // unaffected and still instant — only the all-clear waits.
  //
  // nextBand's 5% hysteresis margin already damps the tightest flapping; this covers
  // the swings that clear the margin but still aren't a real recovery — exactly the
  // shape of bursty traffic on link_util / link_errors.
  //
  // ⚠️ Counts SAMPLES, not seconds, so the wall-clock differs per source: ~3 min on the
  // 60s SNMP poll and ~1.5 min on the 30s MikroTik poll, vs ~30s for a default Go
  // agent. That is a delayed ALL-CLEAR only; nothing is detected later because of it.
  let effectiveBand = band;
  if (band === "normal" && prevBand !== "normal") {
    if (alertBandState.confirmRecovery(deviceId, type)) {
      await alertsService.autoResolveMetric(deviceId, type); // recovered → close open alert
    } else {
      effectiveBand = prevBand; // not convinced yet — stay in the old band
    }
  } else if (band !== "normal") {
    alertBandState.breakRecovery(deviceId, type); // breaching again → run of normals broken
  }
  alertBandState.setBand(deviceId, type, effectiveBand); // track always, so a later breach re-arms

  if (SEV_RANK[effectiveBand] <= SEV_RANK[prevBand]) return null; // only the ONSET of a worse band

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

  // First sighting establishes the baseline and never alerts (links only). Still
  // records the band, so a link already down at startup alerts on its next real
  // up→down, not immediately.
  if (baselineKey && !seenLink.has(baselineKey)) {
    seenLink.add(baselineKey);
    alertBandState.setBand(deviceId, type, band);
    return null;
  }

  // Same recovery confirmation as evalMetric — and it matters MORE here. A boolean has
  // no threshold to put a hysteresis margin around, so this streak is the only damping
  // a flapping link or a stuttering mains supply gets. A port bouncing up/down would
  // otherwise raise + auto-resolve on every single poll.
  let effectiveBand = band;
  if (band === "normal" && prevBand !== "normal") {
    if (alertBandState.confirmRecovery(deviceId, type)) {
      await alertsService.autoResolveMetric(deviceId, type);
    } else {
      effectiveBand = prevBand; // not convinced the link/mains is really back yet
    }
  } else if (band !== "normal") {
    alertBandState.breakRecovery(deviceId, type);
  }
  alertBandState.setBand(deviceId, type, effectiveBand);

  if (SEV_RANK[effectiveBand] <= SEV_RANK[prevBand]) return null;

  const log = await agentService.logDevice(deviceId, severity, message);
  await notificationService.raiseAlert({ deviceId, type, severity, title, message });
  return log;
}

// Point-in-time event (router reboot): raise once on occurrence, never auto-resolved
// because it is not a persistent state. raiseAlert's restart-proof DB cooldown dedups
// repeats. Returns the device_log row for the caller's batch emit.
async function raiseTransient(deviceId, { type, severity, title, message, metricValue = null }) {
  await notificationService.raiseAlert({ deviceId, type, severity, title, message, metricValue });
  return agentService.logDevice(deviceId, severity, message);
}

// sample: { cpuPercent, memPercent, connectedClients, uptimeSeconds,
//           interfaces: [{ name, locationLabel, linkUp, utilizationPct }] }
async function checkRouter(io, device, sample) {
  const id = Number(device.id);
  const events = [];

  events.push(await evalMetric({ deviceId: id, metricName: "router_cpu", type: "router_cpu", value: num(sample.cpuPercent), label: "Router CPU", unit: "%" }));
  events.push(await evalMetric({ deviceId: id, metricName: "router_mem", type: "router_mem", value: num(sample.memPercent), label: "Router memory", unit: "%" }));
  events.push(await evalMetric({ deviceId: id, metricName: "router_clients", type: "router_clients", value: num(sample.connectedClients), label: "Connected clients" }));

  // Unexpected reboot — uptime went backwards vs the last poll. The 60s slack absorbs
  // poll jitter and TimeTicks rounding, so only a genuine restart trips it.
  const up = num(sample.uptimeSeconds);
  if (!Number.isNaN(up)) {
    const lastUp = prevUptime.get(id);
    if (lastUp != null && up < lastUp - 60) {
      events.push(await raiseTransient(id, {
        type: "router_reboot", severity: "warning", title: "Router rebooted",
        message: "Router restarted unexpectedly (uptime reset)",
      }));
    }
    prevUptime.set(id, up);
  }

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

  // Battery needs replacing — RFC 1628 upsBatteryStatus: 2 normal, 3 low, 4 depleted.
  // Battery HEALTH, distinct from charge level: a pack at 100% can still report
  // "replace", and that is the warning that matters most, since a UPS only fails at
  // the moment you actually need it.
  const st = num(sample.batteryStatus);
  if (!Number.isNaN(st)) {
    events.push(await evalEvent({
      deviceId: id, type: "ups_replace_battery", active: st === 3 || st === 4,
      severity: "warning", title: "UPS battery fault",
      message: st === 4 ? "UPS battery depleted — replace battery" : "UPS battery needs replacing",
    }));
  }

  // High battery temperature — direct event with hysteresis (trip >40°C, clear <37°C)
  // so a reading hovering on the boundary can't flap the alert.
  const t = num(sample.temperature);
  if (!Number.isNaN(t)) {
    const hot = alertBandState.getBand(id, "ups_temp") !== "normal" ? t > 37 : t > 40;
    events.push(await evalEvent({
      deviceId: id, type: "ups_temp", active: hot, severity: "warning",
      title: "UPS temperature high", message: `UPS battery temperature high: ${Math.round(t)}°C`,
    }));
  }

  // Abnormal input voltage — trip outside 180–260 V, clear back inside 185–255 V
  // (nominal ~230 V here). Mains sagging before it fails is the early warning.
  const v = num(sample.inputVoltage);
  if (!Number.isNaN(v) && v > 0) {
    const bad = alertBandState.getBand(id, "ups_input_voltage") !== "normal"
      ? (v < 185 || v > 255)
      : (v < 180 || v > 260);
    events.push(await evalEvent({
      deviceId: id, type: "ups_input_voltage", active: bad, severity: "warning",
      title: "UPS input voltage abnormal",
      message: `UPS input voltage out of range: ${Math.round(v)} V (nominal ~230 V)`,
    }));
  }

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

// Drop every in-memory trace of one device. Called from a poller's removeDevice
// alongside alertBandState.resetDevice — that call only clears the SEVERITY bands,
// while the three maps in this module (link baselines, error counters, last uptime)
// would otherwise outlive the device. MySQL reuses an AUTO_INCREMENT id after a
// restart, so a future device inheriting a dead one's state would silently skip the
// first interface-down alert and fire a phantom "Router rebooted" on its first poll.
function resetDevice(deviceId) {
  const id = Number(deviceId);
  const prefix = `${id}:`;
  prevUptime.delete(id);
  for (const k of [...seenLink]) if (k.startsWith(prefix)) seenLink.delete(k);
  for (const k of [...prevErrors.keys()]) if (k.startsWith(prefix)) prevErrors.delete(k);
}

export default { checkRouter, checkUps, checkReachability, resetDevice };
