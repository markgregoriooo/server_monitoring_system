import alertRulesService from "./alertRulesService.js";
import alertBandState from "./alertBandState.js";
import alertsService from "./alertsService.js";
import notificationService from "./notificationService.js";
import { isLinkFault } from "./linkAlertPolicy.js";
import db from "../config/mysql.js";
import { logDevice } from "./deviceLogs.js";
import { describeError } from "../utils/httpError.js";

// ─── Router / UPS threshold alerting ─────────
// Gives MikroTik routers, SNMP routers and UPS units the same alerting as servers
// and the environment: each metric is checked against alert_rules, the current band
// per (device, metric) is kept in alertBandState, and moving into a worse band
// raises a real alert (bell, toast, email, Alerts page) plus a device_log. Recovery
// auto-resolves after ALERT_RECOVERY_SAMPLES normal readings. Hysteresis and the DB
// cooldown come from alertRulesService.nextBand and raiseAlert.
//
// metric_name values (must match the seeded alert_rules and the Alert Rules UI):
//   router_cpu, router_mem, router_clients   (router_metrics, per device)
//   router_latency, router_loss              (ICMP, per device — see checkRouter)
//   link_util                                (network_traffic, per interface)
//   ups_charge, ups_runtime, ups_load        (ups_metrics, per device)
// Events without a numeric threshold (interface down, UPS on battery) are raised
// directly, like server 'offline'.

const SEV_RANK = alertRulesService.SEV_RANK;
// Returns NaN (not null, not a default) for an unusable value, so a comparison
// against a threshold is simply false rather than accidentally passing. N-03.
const numOrNaN = (v) => (v == null || !Number.isFinite(Number(v)) ? NaN : Number(v));

// ─── Which ports may alert (network_interfaces) ──────────────────────
// Stored in MySQL (migration 2026-08-09_link_alert_gate.sql):
//   ever_up      set the first time a poller sees the port with a link
//   monitor_link per-port opt-out, on by default
// An earlier in-memory version depended on which ports were down when the backend
// started. Cached per device because it rarely changes. key `${id}:${name}`.
const linkGate = new Map(); // `${deviceId}:${ifName}` -> { everUp, monitored }
const gateLoaded = new Set(); // deviceIds whose rows have been read at least once

// Bands are in memory, so after a restart an open link_down alert could never
// resolve. Once per device per process, close any open link_down alert whose port
// is not currently a fault.
const reconciled = new Set();

const gateKey = (deviceId, name) => `${Number(deviceId)}:${name}`;

// Most ports have no row (only labelled ones do). No row means never connected,
// monitoring on.
const DEFAULT_GATE = { everUp: false, monitored: true };

async function loadLinkGate(deviceId) {
  const id = Number(deviceId);
  if (gateLoaded.has(id)) return;
  try {
    const [rows] = await db.query(
      `SELECT interface_name, ever_up, monitor_link
         FROM network_interfaces WHERE device_id = ?`,
      [id],
    );
    for (const r of rows) {
      linkGate.set(gateKey(id, r.interface_name), {
        everUp: Boolean(r.ever_up),
        monitored: r.monitor_link !== 0,
      });
    }
    gateLoaded.add(id);
  } catch (err) {
    // If this read fails, every port uses DEFAULT_GATE (silent) and the next poll
    // retries. A DB error should not create an outage alert.
    console.error("[deviceAlerts] link gate load failed:", describeError(err));
  }
}

function gateFor(deviceId, name) {
  return linkGate.get(gateKey(deviceId, name)) ?? DEFAULT_GATE;
}

// Remember the first time a port has a link; from then on it can alert. One write
// per port. Upsert, because most ports have no row yet and there is no UNIQUE index
// on (device_id, interface_name).
async function noteLinkUp(deviceId, name) {
  const id = Number(deviceId);
  const gate = gateFor(id, name);
  if (gate.everUp) return;
  linkGate.set(gateKey(id, name), { ...gate, everUp: true }); // before the await: the
  // next poll is 30s away but concurrent devices share this map, and a double INSERT
  // would leave two rows for one port.
  try {
    const [existing] = await db.query(
      `SELECT id FROM network_interfaces WHERE device_id = ? AND interface_name = ? LIMIT 1`,
      [id, name],
    );
    if (existing.length) {
      await db.query(`UPDATE network_interfaces SET ever_up = 1, updated_at = NOW() WHERE id = ?`, [
        existing[0].id,
      ]);
    } else {
      await db.query(
        `INSERT INTO network_interfaces (device_id, interface_name, location_label, is_active, ever_up, monitor_link)
         VALUES (?, ?, '', 1, 1, 1)`,
        [id, name],
      );
    }
  } catch (err) {
    console.error("[deviceAlerts] ever_up write failed:", describeError(err));
    linkGate.set(gateKey(id, name), gate); // roll back so the next poll retries
  }
}

// Previous error counters per interface, so `link_errors` alerts on new errors
// rather than the lifetime total. key `${deviceId}:${ifName}`.
const prevErrors = new Map();

// Last uptime per device. Lower uptime than last poll means it rebooted; raised
// once per reboot, not tracked as a band. key: deviceId.
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

// Check one numeric metric against its rules. Returns the device_log row created
// on a new escalation (else null). `low` words it for lower-is-worse metrics
// (battery charge / runtime). `iface` looks up per-port rules (link_util /
// link_errors); device-level metrics omit it.
async function evalMetric({ deviceId, metricName, type, value, label, unit = "", low = false, iface = null }) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;

  const prevBand = alertBandState.getBand(deviceId, type);
  const rules = await alertRulesService.getEffectiveRules(deviceId, metricName, iface);
  const { band, rule } = alertRulesService.nextBand(rules, value, prevBand);

  // Recovery needs N normal readings in a row (ALERT_RECOVERY_SAMPLES), so bursty
  // traffic around a link_util threshold raises one alert instead of a stream of
  // alert/resolve pairs. Escalation is still immediate. In time that is about 3 min on
  // the 60s SNMP poll and 1.5 min on the 30s MikroTik poll. See alertsService.settleBand.
  const { effective: effectiveBand, downgraded, dropped } =
    await alertsService.settleBand(deviceId, type, prevBand, band);
  const shown = Number.isInteger(value) ? `${value}${unit}` : `${Math.round(value)}${unit}`;

  // A confirmed drop is logged too, so the event history shows each problem ENDING.
  if (dropped && !downgraded) {
    return logDevice(deviceId, dropped === "normal" ? "info" : dropped,
      dropped === "normal" ? `${label} recovered: ${shown}` : `${label} down to ${dropped}: ${shown}`);
  }

  // Only the ONSET of a worse band — or a confirmed drop into a band with no open alert.
  if (!downgraded && SEV_RANK[effectiveBand] <= SEV_RANK[prevBand]) return null;

  const word = low
    ? band === "critical" ? "critically low" : "low"
    : band === "critical" ? "critical" : "high";
  const message = `${label} ${word}: ${shown}`;

  const log = await logDevice(deviceId, band, downgraded ? `${label} down to ${band}: ${shown}` : message);
  await notificationService.raiseAlert({
    deviceId, type, severity: band, title: `${label} ${word}`, message,
    metricValue: value, alertRuleId: rule?.alert_rule_id ?? null,
  });
  return log;
}

// On/off event (interface up/down, UPS on/off battery): alert when it starts,
// auto-resolve when it ends. For links the caller uses linkAlertPolicy.isLinkFault,
// so a port that is disabled or muted reports inactive and its alert resolves.
async function evalEvent({ deviceId, type, active, severity, title, message }) {
  const band = active ? severity : "normal";
  const prevBand = alertBandState.getBand(deviceId, type);

  // Same recovery confirmation as evalMetric. An on/off event has no threshold margin,
  // so this is the only thing stopping a flapping link from alerting on every poll.
  const { effective: effectiveBand, dropped } =
    await alertsService.settleBand(deviceId, type, prevBand, band);

  // Log the end as well as the start, so "UPS on battery" is followed by its clearing.
  if (dropped) return logDevice(deviceId, "info", `Cleared: ${title}`);

  if (SEV_RANK[effectiveBand] <= SEV_RANK[prevBand]) return null;

  const log = await logDevice(deviceId, severity, message);
  await notificationService.raiseAlert({ deviceId, type, severity, title, message });
  return log;
}

// One-off event (router reboot): raised once, never auto-resolved. raiseAlert's DB
// cooldown drops repeats. Returns the device_log row.
async function raiseTransient(deviceId, { type, severity, title, message, metricValue = null }) {
  await notificationService.raiseAlert({ deviceId, type, severity, title, message, metricValue });
  return logDevice(deviceId, severity, message);
}

// sample: { cpuPercent, memPercent, connectedClients, uptimeSeconds,
//           interfaces: [{ name, locationLabel, linkUp, utilizationPct }] }
async function checkRouter(io, device, sample) {
  const id = Number(device.id);
  const events = [];
  await loadLinkGate(id); // cached after the first poll
  const cleared = []; // link_down types to reconcile on this process's first pass

  events.push(await evalMetric({ deviceId: id, metricName: "router_cpu", type: "router_cpu", value: numOrNaN(sample.cpuPercent), label: "Router CPU", unit: "%" }));
  events.push(await evalMetric({ deviceId: id, metricName: "router_mem", type: "router_mem", value: numOrNaN(sample.memPercent), label: "Router memory", unit: "%" }));
  events.push(await evalMetric({ deviceId: id, metricName: "router_clients", type: "router_clients", value: numOrNaN(sample.connectedClients), label: "Connected clients" }));

  // ── ICMP link quality ────────────────────────────────────────────────────────
  // SNMP either answers or times out, so it cannot show a link that is up but losing
  // packets. These two catch that, and they are the only numeric metrics a ping-only
  // router has.
  //
  // Only checked while the device answers: a down host reports 100% loss, which would
  // just duplicate the "offline" alert with a misleading message. `!== false` keeps
  // evaluating samples that never set `reachable`. An alert already open when the
  // device went down stays open and resolves after recovery.
  if (sample.reachable !== false) {
    events.push(await evalMetric({ deviceId: id, metricName: "router_latency", type: "router_latency", value: numOrNaN(sample.latencyMs), label: "Latency", unit: " ms" }));
    events.push(await evalMetric({ deviceId: id, metricName: "router_loss", type: "router_loss", value: numOrNaN(sample.packetLossPct), label: "Packet loss", unit: "%" }));
  }

  // Unexpected reboot — uptime went backwards vs the last poll. The 60s slack absorbs
  // poll jitter and TimeTicks rounding, so only a genuine restart trips it.
  const up = numOrNaN(sample.uptimeSeconds);
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
    // Per-interface link utilization. Each interface has its own band and alert. A port
    // can have its own threshold (an ISP uplink and an access port differ); otherwise
    // the device rule, then the global one, is used.
    events.push(await evalMetric({
      deviceId: id, metricName: "link_util", type: `link_util:${i.name}`, iface: i.name,
      value: numOrNaN(i.utilizationPct), label: `Link ${ifaceLabel}`, unit: "%",
    }));
    // A port carrying a link right now becomes alert-eligible from here on — this is
    // the fact that separates "a building went dark" from "that socket is empty".
    if (i.linkUp === true) await noteLinkUp(id, i.name);

    // Only a port that is enabled, monitored and has had a link before counts as down.
    // See linkAlertPolicy.
    const gate = gateFor(id, i.name);
    const faulted = isLinkFault({
      adminUp: i.adminUp, linkUp: i.linkUp,
      everUp: gate.everUp, monitored: gate.monitored,
    });
    if (!faulted && !reconciled.has(id)) cleared.push(`link_down:${i.name}`);
    events.push(await evalEvent({
      deviceId: id, type: `link_down:${i.name}`, active: faulted,
      severity: "warning", title: "Interface down",
      message: `Interface ${ifaceLabel} is down`,
    }));

    // Rising rx/tx errors (bad cable, duplex mismatch). Uses the per-poll change, not
    // the lifetime counter.
    const errDelta = errorDelta(id, i.name, (numOrNaN(i.rxErrors) || 0) + (numOrNaN(i.txErrors) || 0));
    events.push(await evalMetric({
      deviceId: id, metricName: "link_errors", type: `link_errors:${i.name}`, iface: i.name,
      value: errDelta, label: `Link ${ifaceLabel} errors`,
    }));
  }

  // See `reconciled`: close link_down alerts the in-memory band can no longer resolve.
  // One indexed SELECT per port, once per process.
  if (!reconciled.has(id)) {
    reconciled.add(id);
    for (const type of cleared) {
      try {
        await alertsService.autoResolveMetric(id, type);
      } catch (err) {
        console.error("[deviceAlerts] link reconcile failed:", describeError(err));
      }
    }
  }

  for (const e of events) if (e) io?.emit("deviceLog", e);
  return events.filter(Boolean);
}

// sample: { batteryChargePct, runtimeRemainingMin, loadPct, onBattery }
async function checkUps(io, device, sample) {
  const id = Number(device.id);
  const events = [];

  // ─── Power source (RFC 1628 upsOutputSource) ─────────────
  // Three separate problems, each an on/off event.

  // On-battery = mains lost. Loud, and you have N minutes.
  events.push(await evalEvent({
    deviceId: id, type: "ups_on_battery", active: sample.onBattery === true,
    severity: "critical", title: "UPS on battery",
    message: "UPS switched to battery power (mains lost)",
  }));

  // On bypass: the load runs on raw mains around the inverter and battery. Critical,
  // since there is no protection at all. `onBattery` only checks battery(5), so bypass
  // (4) used to look healthy.
  events.push(await evalEvent({
    deviceId: id, type: "ups_on_bypass", active: sample.onBypass === true,
    severity: "critical", title: "UPS on bypass",
    message: "UPS is on BYPASS — load is on raw mains with no battery protection. "
      + "Check for an overload, an over-temperature, or a maintenance bypass switch left engaged.",
  }));

  // Output off entirely — the UPS is not feeding the load at all.
  events.push(await evalEvent({
    deviceId: id, type: "ups_output_off", active: sample.outputState === "off",
    severity: "critical", title: "UPS output off",
    message: "UPS reports no output source — the protected load is not being powered",
  }));

  // Booster/reducer (AVR) raises nothing: the load is still protected and
  // `ups_input_voltage` already alerts on the bad mains. It still shows on the
  // dashboard as `outputState: "avr"`.

  events.push(await evalMetric({ deviceId: id, metricName: "ups_charge", type: "ups_charge", value: numOrNaN(sample.batteryChargePct), label: "UPS battery", unit: "%", low: true }));
  events.push(await evalMetric({ deviceId: id, metricName: "ups_runtime", type: "ups_runtime", value: numOrNaN(sample.runtimeRemainingMin), label: "UPS runtime", unit: " min", low: true }));
  events.push(await evalMetric({ deviceId: id, metricName: "ups_load", type: "ups_load", value: numOrNaN(sample.loadPct), label: "UPS load", unit: "%" }));

  // Battery needs replacing (upsBatteryStatus: 2 normal, 3 low, 4 depleted). This is
  // battery health, not charge: a full battery can still report "replace".
  const st = numOrNaN(sample.batteryStatus);
  if (!Number.isNaN(st)) {
    events.push(await evalEvent({
      deviceId: id, type: "ups_replace_battery", active: st === 3 || st === 4,
      severity: "warning", title: "UPS battery fault",
      message: st === 4 ? "UPS battery depleted — replace battery" : "UPS battery needs replacing",
    }));
  }

  // High battery temperature — direct event with hysteresis (trip >40°C, clear <37°C)
  // so a reading hovering on the boundary can't flap the alert.
  const t = numOrNaN(sample.temperature);
  if (!Number.isNaN(t)) {
    const hot = alertBandState.getBand(id, "ups_temp") !== "normal" ? t > 37 : t > 40;
    events.push(await evalEvent({
      deviceId: id, type: "ups_temp", active: hot, severity: "warning",
      title: "UPS temperature high", message: `UPS battery temperature high: ${Math.round(t)}°C`,
    }));
  }

  // Abnormal input voltage — trip outside 180–260 V, clear back inside 185–255 V
  // (nominal ~230 V here). Mains sagging before it fails is the early warning.
  const v = numOrNaN(sample.inputVoltage);
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

// Reachability as a real alert (offline = open, online = auto-resolve), like server
// 'offline'. Called from each poller's setReachable on a status change, so it fires
// once per change. Routers and MikroTik are critical; an unreachable UPS is a warning.
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

// Forget everything held in memory for a device (link gate cache, error counters,
// last uptime). Called with alertBandState.resetDevice when a device is removed, so a
// new device that reuses the id does not inherit its state. The ever_up and
// monitor_link rows are deleted by the FK cascade.
function resetDevice(deviceId) {
  const id = Number(deviceId);
  const prefix = `${id}:`;
  prevUptime.delete(id);
  gateLoaded.delete(id);
  reconciled.delete(id);
  for (const k of [...linkGate.keys()]) if (k.startsWith(prefix)) linkGate.delete(k);
  for (const k of [...prevErrors.keys()]) if (k.startsWith(prefix)) prevErrors.delete(k);
}

// Called after an admin edits a port's monitor_link so the change takes effect on the
// next poll rather than at the next backend restart.
function invalidateLinkGate(deviceId) {
  const id = Number(deviceId);
  gateLoaded.delete(id);
  for (const k of [...linkGate.keys()]) if (k.startsWith(`${id}:`)) linkGate.delete(k);
}

export default { checkRouter, checkUps, checkReachability, resetDevice, invalidateLinkGate };
