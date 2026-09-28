import alertRulesService from "./alertRulesService.js";
import alertBandState from "./alertBandState.js";
import alertsService from "./alertsService.js";
import notificationService from "./notificationService.js";
import { isLinkFault } from "./linkAlertPolicy.js";
import db from "../config/mysql.js";
import { logDevice } from "./deviceLogs.js";
import { describeError } from "../utils/httpError.js";

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
//   router_latency, router_loss              (ICMP, per device — see checkRouter)
//   link_util                                (network_traffic, per interface)
//   ups_charge, ups_runtime, ups_load        (ups_metrics, per device)
// Boolean events that aren't numeric thresholds (interface down, UPS on battery) are
// raised directly — like server 'offline' — not via alert_rules.

const SEV_RANK = alertRulesService.SEV_RANK;
// Returns NaN (not null, not a default) for an unusable value, so a comparison
// against a threshold is simply false rather than accidentally passing. N-03.
const numOrNaN = (v) => (v == null || !Number.isFinite(Number(v)) ? NaN : Number(v));

// ─── Which ports are allowed to alert (network_interfaces) ──────────────────────
// Replaces an in-memory `seenLink` Set that skipped the first sighting of every port.
// That baseline hid empty-socket noise, but it re-rolled on every restart: whichever
// ports happened to be down at boot went permanently silent, and — worse — a real
// uplink unplugged during a restart was baselined as "known down" and could never
// alert again. Which ports were live was a property of process start time.
//
// Both facts now live in MySQL (migration 2026-08-09_link_alert_gate.sql):
//   ever_up      set once, the first time a poller sees the port carrying a link
//   monitor_link ICTU's per-port opt-out, default on
//
// Cached per device so the hot path costs nothing: the pollers call checkRouter every
// 30-60s, and this data changes at most once in a port's lifetime. key `${id}:${name}`.
const linkGate = new Map(); // `${deviceId}:${ifName}` -> { everUp, monitored }
const gateLoaded = new Set(); // deviceIds whose rows have been read at least once

// Alerts are persisted in MySQL, but the severity bands that auto-resolve them are
// in-memory. A restart therefore strands an open link_down alert: the band comes back
// as "normal", the recovery path only fires on a normal-after-abnormal transition that
// can no longer happen, and the incident sits open forever with nothing left to close
// it. This bites hardest right after the gate change, where a port that just became
// ineligible (empty socket, newly disabled, silenced) will never report a fault again.
// So: once per device per process, close any open link_down alert whose port is not
// currently a fault. One pass, not one per poll.
const reconciled = new Set();

const gateKey = (deviceId, name) => `${Number(deviceId)}:${name}`;

// A port with no row is the common case (rows are optional — only labelled ports have
// one), so the absence of a row must read as a real answer, not a lookup failure:
// never connected, monitoring on.
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
    // Alerting must not depend on this read succeeding. Leaving the device unloaded
    // means every port falls back to DEFAULT_GATE — silent — and the next poll retries.
    // Failing quiet is the right direction: a DB hiccup should not invent an outage.
    console.error("[deviceAlerts] link gate load failed:", describeError(err));
  }
}

function gateFor(deviceId, name) {
  return linkGate.get(gateKey(deviceId, name)) ?? DEFAULT_GATE;
}

// First time a port is seen carrying a link, remember it — this is what makes a port
// alert-eligible from then on. Writes once per port per lifetime, not once per poll.
// Upserts because most ports have no row until now (labelling was the only thing that
// created one), and there is no UNIQUE index on (device_id, interface_name) to lean on.
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
  // Counts SAMPLES, not seconds, so the wall-clock differs per source: ~3 min on the
  // 60s SNMP poll and ~1.5 min on the 30s MikroTik poll, vs ~30s for a default Go
  // agent. That is a delayed ALL-CLEAR only; nothing is detected later because of it.
  // A confirmed drop closes what it has made untrue (critical → warning closes the
  // CRITICAL alert). See alertsService.settleBand.
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

// Boolean-state event (interface up/down, UPS on/off battery): a real alert on the
// onset, auto-resolve on recovery. Callers decide what counts as `active` — for links
// that decision is linkAlertPolicy.isLinkFault, so a port that stops being alert-
// eligible (disabled in RouterOS, silenced by an admin) simply reports active:false
// and any open alert auto-resolves through the normal recovery path.
async function evalEvent({ deviceId, type, active, severity, title, message }) {
  const band = active ? severity : "normal";
  const prevBand = alertBandState.getBand(deviceId, type);

  // Same recovery confirmation as evalMetric — and it matters MORE here. A boolean has
  // no threshold to put a hysteresis margin around, so this streak is the only damping
  // a flapping link or a stuttering mains supply gets. A port bouncing up/down would
  // otherwise raise + auto-resolve on every single poll.
  const { effective: effectiveBand, dropped } =
    await alertsService.settleBand(deviceId, type, prevBand, band);

  // Log the end as well as the start, so "UPS on battery" is followed by its clearing.
  if (dropped) return logDevice(deviceId, "info", `Cleared: ${title}`);

  if (SEV_RANK[effectiveBand] <= SEV_RANK[prevBand]) return null;

  const log = await logDevice(deviceId, severity, message);
  await notificationService.raiseAlert({ deviceId, type, severity, title, message });
  return log;
}

// Point-in-time event (router reboot): raise once on occurrence, never auto-resolved
// because it is not a persistent state. raiseAlert's restart-proof DB cooldown dedups
// repeats. Returns the device_log row for the caller's batch emit.
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
  // The two things SNMP structurally cannot report. An SNMP walk either answers or
  // times out, so a link that is UP and dropping a third of its packets looks
  // perfectly healthy until it finally crosses into a flat Offline — by which point
  // the useful warning window has passed. These are also the ONLY numeric metrics a
  // ping-only router has, so without them such a device could raise nothing but
  // "unreachable": working or dead, with no degraded state in between.
  //
  // Both come from icmpPing via the poller, on SNMP and ping devices alike.
  //
  //  ONLY WHILE THE DEVICE IS ANSWERING. icmpPing reports `packetLossPct: 100` for an
  // unreachable host, which is a correct MEASUREMENT and a useless ALERT: every outage
  // raised two criticals, and the louder of the two named the wrong problem. Nobody paged
  // for "Packet loss 100%" learns anything "Router offline" had not already said, and the
  // packet-loss wording sends them looking for a bad cable when the box is simply down.
  //
  // Degradation only means something while the device is still replying — a link dropping
  // a third of its packets is exactly the state these two exist to catch, and it is a state
  // of a device that is UP. Once it is down, `device_offline` owns the incident.
  //
  // `!== false` rather than truthiness: the SNMP path sets `reachable: true` explicitly, but
  // a sample that never set the field at all must keep being evaluated rather than silently
  // losing its link-quality alerting.
  //
  // An alert that was ALREADY open when the device went down is deliberately left open: the
  // degradation that preceded the outage is real history, and it auto-resolves on recovery
  // when loss returns to normal.
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
    // Per-interface link saturation — one global `link_util` rule covers every
    // interface; the per-interface `type` keeps each interface's band, alert and
    // auto-resolve independent.
    // `iface` lets a port carry its own threshold — an ISP uplink that normally sits at
    // 70% and an access port that should never exceed 5% can't share one number.
    // Falls back to the device-wide rule, then global, when no per-port rule exists.
    events.push(await evalMetric({
      deviceId: id, metricName: "link_util", type: `link_util:${i.name}`, iface: i.name,
      value: numOrNaN(i.utilizationPct), label: `Link ${ifaceLabel}`, unit: "%",
    }));
    // A port carrying a link right now becomes alert-eligible from here on — this is
    // the fact that separates "a building went dark" from "that socket is empty".
    if (i.linkUp === true) await noteLinkUp(id, i.name);

    // Only a port that is enabled, monitored and has carried a link before can be
    // "down" in the sense worth waking someone for. See linkAlertPolicy for the four
    // questions and why each one is there.
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

    // Rising rx/tx errors — the classic failing-cable / duplex-mismatch signal. Uses
    // the per-poll DELTA, not the lifetime counter, so a long-running router doesn't
    // sit permanently in alarm over errors from months ago.
    const errDelta = errorDelta(id, i.name, (numOrNaN(i.rxErrors) || 0) + (numOrNaN(i.txErrors) || 0));
    events.push(await evalMetric({
      deviceId: id, metricName: "link_errors", type: `link_errors:${i.name}`, iface: i.name,
      value: errDelta, label: `Link ${ifaceLabel} errors`,
    }));
  }

  // See `reconciled` — close link_down incidents that the in-memory band can no longer
  // resolve on its own. autoResolveMetric no-ops when nothing is open, so the usual
  // case costs one indexed SELECT per port, once per process.
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

  // ─── Where the load is being fed from (RFC 1628 upsOutputSource) ─────────────
  // Three distinct ways to be in trouble, all boolean events rather than rules —
  // like server 'offline', there is no threshold to hang hysteresis on.

  // On-battery = mains lost. Loud, and you have N minutes.
  events.push(await evalEvent({
    deviceId: id, type: "ups_on_battery", active: sample.onBattery === true,
    severity: "critical", title: "UPS on battery",
    message: "UPS switched to battery power (mains lost)",
  }));

  // On-BYPASS = the load is wired straight to raw mains, around the inverter and
  // the battery. Critical, not warning: the racks are running but have ZERO
  // protection, so the next mains dip takes them down with no runtime at all.
  //
  // This was silent until now. `onBattery` tests upsOutputSource === battery(5),
  // so bypass(4) reported false and the UPS read as perfectly healthy — a green
  // tile in front of an unprotected rack. Exactly backwards from the risk.
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

  // NOTE: booster/reducer (AVR — mains present but out of spec, being boosted or
  // trimmed) deliberately raises nothing here. The load is still protected, and the
  // `ups_input_voltage` event below already alerts on the bad mains that causes it;
  // adding a second alert would double-report one condition. It is carried through
  // to the dashboard as `outputState: "avr"` so it can still be SEEN.

  events.push(await evalMetric({ deviceId: id, metricName: "ups_charge", type: "ups_charge", value: numOrNaN(sample.batteryChargePct), label: "UPS battery", unit: "%", low: true }));
  events.push(await evalMetric({ deviceId: id, metricName: "ups_runtime", type: "ups_runtime", value: numOrNaN(sample.runtimeRemainingMin), label: "UPS runtime", unit: " min", low: true }));
  events.push(await evalMetric({ deviceId: id, metricName: "ups_load", type: "ups_load", value: numOrNaN(sample.loadPct), label: "UPS load", unit: "%" }));

  // Battery needs replacing — RFC 1628 upsBatteryStatus: 2 normal, 3 low, 4 depleted.
  // Battery HEALTH, distinct from charge level: a pack at 100% can still report
  // "replace", and that is the warning that matters most, since a UPS only fails at
  // the moment you actually need it.
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
// while the maps in this module (link gate cache, error counters, last uptime) would
// otherwise outlive the device. MySQL reuses an AUTO_INCREMENT id after a restart, so
// a future device inheriting a dead one's state would fire a phantom "Router rebooted"
// on its first poll and treat a fresh port as already alert-eligible.
//
// The persisted ever_up / monitor_link rows need no cleanup here: network_interfaces
// is FK ON DELETE CASCADE, so deleting the device takes them with it.
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
