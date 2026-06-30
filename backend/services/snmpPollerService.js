import db from "../config/mysql.js";
import client, { SYS_OID, IF_OID, IF_OPER_STATUS, UPS_OID, isOnBattery } from "./snmpClient.js";
import agentService from "./agentService.js";
import notificationService from "./notificationService.js";
import alertsService from "./alertsService.js";
import { writeNetworkSample } from "../handlers/networkMetricsHandler.js";
import { writeUpsSample } from "../handlers/upsMetricsHandler.js";

// ─── SNMP poller: routers (IF-MIB) + UPS (UPS-MIB), pull-based ─────────────────
//
// The mirror image of the Go-agent pipeline: instead of agents PUSHing metrics,
// this service PULLs them by polling each device over SNMP on a timer. One service
// covers both classes — only the OID set differs. server.js drives pollAll() on an
// interval (like the offline sweep). Because polling IS the heartbeat, there's no
// separate offline sweep: each cycle directly knows whether a device answered, and
// flips devices.status accordingly.
//
// SNMP-only (design scope): a device is pollable only if it has an IP + community
// string (and, for a UPS, communication_type snmp/network). Unmanaged routers that
// would need ICMP-ping fallback are skipped for now — see the note in loadDevices.

const SNMP_TIMEOUT_MS = 5000;
const SNMP_RETRIES = 1;

// ─── In-memory state (resets on restart, repopulates on the next cycle) ─────────

// Previous per-interface byte counters, for utilization_pct (rate ÷ link speed).
// key `${deviceId}:${ifIndex}` -> { rxBytes(BigInt), txBytes(BigInt), t(ms) }
const prevIface = new Map();
// Per-condition active state, for alert onset/recovery transitions (drives both the
// device_logs entry and the alert lifecycle). key `${deviceId}:${type}` -> boolean
const condState = new Map();
// Router alert helpers: consecutive over-ceiling polls (sustained-utilization), the
// last error counters (error-burst delta), and last uptime (reboot detection).
const utilHighCount = new Map(); // `${id}:${name}` -> consecutive polls over the ceiling
const prevErrors = new Map();    // `${id}:${name}` -> { rx, tx } cumulative error counters
const prevUptime = new Map();    // deviceId -> last uptimeSeconds

// Latest live values per device, so GET /api/network and GET /api/ups render
// current numbers immediately (mirrors agentService.latestMetrics for servers).
// Resets on restart, repopulates on the next poll cycle.
const latestNetwork = new Map(); // id -> shaped router summary
const latestUps = new Map(); // id -> shaped UPS summary

const STATUS_LABEL = { online: "Online", offline: "Offline", warning: "Warning", maintenance: "Maintenance" };
const labelStatus = (s) => STATUS_LABEL[s] ?? "Offline";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const numOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const firstValue = (m) => {
  const k = Object.keys(m)[0];
  return k === undefined ? null : m[k];
};
const connFor = (d) => ({
  host: d.ip,
  community: d.community || "public",
  port: d.snmpPort || 161,
  timeout: SNMP_TIMEOUT_MS,
  retries: SNMP_RETRIES,
});

// ─── Collectors (pure SNMP → sample; no DB, no Influx — unit-testable) ──────────

// Poll one router/switch and return a shaped network sample. Computes
// utilization_pct from the delta vs the previous cycle's counters. Throws on a
// transport failure (unreachable) — the caller treats that as "offline".
export async function collectRouter(deviceId, conn, labels = {}) {
  const session = client.openSession(conn);
  try {
    const sys = await client.get(session, [SYS_OID.sysDescr, SYS_OID.sysUpTime, SYS_OID.sysName]);

    // Walk the IF-MIB columns we need (sequential — one UDP session).
    const names = await client.walkColumn(session, IF_OID.ifName);
    const oper = await client.walkColumn(session, IF_OID.ifOperStatus);
    const hcIn = await client.walkColumn(session, IF_OID.ifHCInOctets);
    const hcOut = await client.walkColumn(session, IF_OID.ifHCOutOctets);
    const speed = await client.walkColumn(session, IF_OID.ifHighSpeed);
    const inErr = await client.walkColumn(session, IF_OID.ifInErrors);
    const outErr = await client.walkColumn(session, IF_OID.ifOutErrors);

    const now = Date.now();
    const interfaces = [];
    // Iterate interfaces that report HC in-octets (the counters we graph).
    for (const idx of Object.keys(hcIn)) {
      const rxBytes = typeof hcIn[idx] === "bigint" ? hcIn[idx] : BigInt(hcIn[idx] ?? 0);
      const txBytes = typeof hcOut[idx] === "bigint" ? hcOut[idx] : BigInt(hcOut[idx] ?? 0);
      const name = (names[idx] && String(names[idx])) || `if${idx}`;
      const linkUp = Number(oper[idx]) === IF_OPER_STATUS.up;
      const speedMbps = Number(speed[idx] ?? 0);

      // utilization_pct from the per-interface delta vs the previous cycle.
      let utilizationPct = null;
      const key = `${deviceId}:${idx}`;
      const prev = prevIface.get(key);
      if (prev) {
        const dt = (now - prev.t) / 1000;
        // Discard a negative delta (counter wrap / device reboot) rather than spike.
        const dRx = rxBytes >= prev.rxBytes ? Number(rxBytes - prev.rxBytes) : 0;
        const dTx = txBytes >= prev.txBytes ? Number(txBytes - prev.txBytes) : 0;
        if (dt > 0 && speedMbps > 0) {
          const capacityBytesPerSec = (speedMbps * 1e6) / 8; // Mbit/s → bytes/s
          const bytesPerSec = (dRx + dTx) / dt;
          utilizationPct = Math.min(100, (bytesPerSec / capacityBytesPerSec) * 100);
        }
      }
      prevIface.set(key, { rxBytes, txBytes, t: now });

      interfaces.push({
        name,
        locationLabel: labels[name] ?? "",
        rxBytes,
        txBytes,
        rxErrors: Number(inErr[idx] ?? 0),
        txErrors: Number(outErr[idx] ?? 0),
        linkUp,
        utilizationPct,
      });
    }

    return {
      reachable: true,
      descr: sys[SYS_OID.sysDescr] ?? null,
      sysName: sys[SYS_OID.sysName] ?? null,
      uptimeSeconds: sys[SYS_OID.sysUpTime] != null ? Number(sys[SYS_OID.sysUpTime]) / 100 : null, // TimeTicks → s
      cpuPercent: null, // vendor MIB — not standardized; left for a per-vendor follow-up
      memPercent: null,
      latencyMs: null, // ICMP — separate module (see loadDevices note)
      packetLossPct: null,
      connectedClients: null,
      interfaces,
    };
  } finally {
    client.closeSession(session);
  }
}

// Poll one UPS and return a shaped UPS sample. Voltage/load are per-line table
// columns — we take the first line. Throws on a transport failure (unreachable).
export async function collectUps(conn) {
  const session = client.openSession(conn);
  try {
    const s = await client.get(session, [
      UPS_OID.upsEstimatedChargeRemaining,
      UPS_OID.upsEstimatedMinutesRemaining,
      UPS_OID.upsOutputSource,
      UPS_OID.upsBatteryStatus,
      UPS_OID.upsBatteryVoltage,
      UPS_OID.upsBatteryTemperature,
    ]);
    const inV = await client.walkColumn(session, UPS_OID.upsInputVoltage);
    const outV = await client.walkColumn(session, UPS_OID.upsOutputVoltage);
    const load = await client.walkColumn(session, UPS_OID.upsOutputPercentLoad);

    const battV = s[UPS_OID.upsBatteryVoltage];
    const src = s[UPS_OID.upsOutputSource];
    return {
      reachable: true,
      batteryChargePct: numOrNull(s[UPS_OID.upsEstimatedChargeRemaining]),
      runtimeRemainingMin: numOrNull(s[UPS_OID.upsEstimatedMinutesRemaining]),
      loadPct: numOrNull(firstValue(load)),
      inputVoltage: numOrNull(firstValue(inV)),
      outputVoltage: numOrNull(firstValue(outV)),
      batteryVoltage: battV == null ? null : Number(battV) / 10, // RFC 1628: 0.1 V DC units
      onBattery: src == null ? null : isOnBattery(src),
      batteryStatus: numOrNull(s[UPS_OID.upsBatteryStatus]),
      temperature: numOrNull(s[UPS_OID.upsBatteryTemperature]),
    };
  } finally {
    client.closeSession(session);
  }
}

// ─── DB reads ──────────────────────────────────────────────────────────────────

// Load the routers + UPS to poll, with their SNMP connection details. A device is
// pollable only with an IP + community (SNMP-only scope). A UPS additionally needs
// communication_type snmp/network — a usb/serial UPS can't be reached over SNMP.
// NOTE: managed-by-ping-only routers (no community) are intentionally excluded for
// now; ICMP-ping fallback is a separate small module (design doc §4/§6).
async function loadDevices() {
  const [rows] = await db.query(
    `SELECT d.device_id AS id, d.device_name AS name, d.ip_address AS ip,
            d.device_type AS type, d.status, d.location,
            n.snmp_port AS snmpPort, n.snmp_community AS community,
            u.communication_type AS commType
       FROM devices d
       LEFT JOIN device_network n ON n.device_id = d.device_id
       LEFT JOIN ups_details u     ON u.device_id = d.device_id
      WHERE d.device_type IN ('router','ups')`,
  );
  return rows.filter(
    (r) => r.ip && r.community && (r.type !== "ups" || ["snmp", "network"].includes(r.commType)),
  );
}

async function loadInterfaceLabels(deviceId) {
  const [rows] = await db.query(
    `SELECT interface_name, location_label FROM network_interfaces WHERE device_id = ?`,
    [deviceId],
  );
  const m = {};
  for (const r of rows) m[r.interface_name] = r.location_label ?? "";
  return m;
}

// ─── Status + threshold logging ────────────────────────────────────────────────

const typeLabel = (d) => (d.type === "ups" ? "UPS" : "Router");

// Flip devices.status only on a real change, log the transition once, and emit a
// status event so the page updates live. Reachability comes straight from the poll.
async function setReachable(io, d, online) {
  const id = Number(d.id);
  // Keep the live cache in step with reachability so the list endpoint reflects
  // an offline device immediately (the success path caches richer data below).
  if (!online) {
    if (d.type === "ups") latestUps.set(id, { ...(latestUps.get(id) ?? {}), status: "Offline" });
    else latestNetwork.set(id, { status: "Offline", reachable: false, uptimeSeconds: null, interfaces: [] });
  }
  const newStatus = online ? "online" : "offline";
  if (d.status === newStatus) return;
  try {
    await db.query(`UPDATE devices SET status = ?, updated_at = NOW() WHERE device_id = ?`, [newStatus, d.id]);
  } catch (err) {
    console.error("[SNMP_POLLER] status update error:", err.message);
  }
  const log = await agentService.logDevice(
    d.id,
    online ? "info" : "warning",
    online ? `${typeLabel(d)} reachable` : `${typeLabel(d)} unreachable — no SNMP response`,
  );
  if (log) io?.emit("deviceLog", log);
  io?.emit(d.type === "ups" ? "upsStatus" : "networkStatus", {
    id: d.id,
    status: online ? "Online" : "Offline",
  });

  // Bell + email: raise on the offline transition, auto-resolve on recovery. Router
  // down is critical (carries traffic); a UPS that stops answering is a warning.
  if (online) {
    await alertsService.autoResolveMetric(d.id, "device_offline");
  } else {
    await notificationService.raiseAlert({
      deviceId: d.id,
      type: "device_offline",
      severity: d.type === "ups" ? "warning" : "critical",
      title: `${typeLabel(d)} offline`,
      message: `${typeLabel(d)} "${d.name}" is unreachable over SNMP.`,
    });
  }
}

// ─── Alert conditions (bell + email via raiseAlert, lifecycle via autoResolveMetric) ──
//
// applyConditions() drives BOTH the per-device event log (device_logs, once per
// onset/recovery) AND the operator alert pipeline. On a condition's onset it raises
// an alert (notificationService de-dups, so calling every poll is safe); on recovery
// it auto-resolves the open alert. `active === null` (metric unavailable) is skipped —
// neither raised nor resolved. `transient` conditions (reboot, error burst) raise on
// each occurrence but are never auto-resolved (point-in-time events, not states).
// Thresholds are hardcoded here (with hysteresis to stop flapping); they could move to
// alert_rules later for admin tuning.

const pct = (v) => (v == null ? "—" : `${Math.round(v)}%`);
const mins = (v) => (v == null ? "—" : `${Math.round(v)} min`);
const degC = (v) => (v == null ? "—" : `${Math.round(v)}°C`);
const volts = (v) => (v == null ? "—" : `${Math.round(v)} V`);

async function applyConditions(io, device, conditions) {
  for (const c of conditions) {
    if (c.active === null || c.active === undefined) continue;
    const key = `${device.id}:${c.type}`;
    const prev = condState.get(key) ?? false;
    if (c.active) {
      await notificationService.raiseAlert({
        deviceId: device.id, type: c.type, title: c.title,
        message: c.message, severity: c.severity, metricValue: c.metricValue ?? null,
      });
      if (!prev) {
        const log = await agentService.logDevice(device.id, c.severity, c.message);
        if (log) io?.emit("deviceLog", log);
      }
    } else if (prev && !c.transient) {
      await alertsService.autoResolveMetric(device.id, c.type);
      const log = await agentService.logDevice(device.id, "info", c.recover ?? `${c.title} recovered`);
      if (log) io?.emit("deviceLog", log);
    }
    condState.set(key, c.active);
  }
}

// Router/switch: per-interface down + sustained high utilization + error bursts,
// plus an unexpected-reboot event (uptime went backwards vs the last poll).
async function checkRouterThresholds(io, d, sample) {
  const conditions = [];

  const up = sample.uptimeSeconds;
  const lastUp = prevUptime.get(d.id);
  if (up != null) {
    if (lastUp != null && up < lastUp - 60) {
      conditions.push({
        type: "router_reboot", severity: "warning", transient: true, active: true,
        title: "Router rebooted", message: `${d.name} restarted unexpectedly (uptime reset).`,
      });
    }
    prevUptime.set(d.id, up);
  }

  for (const i of sample.interfaces) {
    conditions.push({
      type: `iface_down:${i.name}`, severity: "warning", active: !i.linkUp,
      title: `Interface ${i.name} down`,
      message: `Interface ${i.name}${i.locationLabel ? ` (${i.locationLabel})` : ""} on ${d.name} is down.`,
      recover: `Interface ${i.name} is back up.`,
    });

    // Sustained high utilization — over the ceiling for ≥3 consecutive polls.
    const ukey = `${d.id}:${i.name}`;
    const util = i.linkUp ? (i.utilizationPct ?? null) : 0;
    if (util != null) {
      const n = util > 90 ? (utilHighCount.get(ukey) ?? 0) + 1 : 0;
      utilHighCount.set(ukey, n);
      conditions.push({
        type: `iface_util:${i.name}`, severity: "warning", metricValue: util, active: n >= 3,
        title: `Interface ${i.name} congested`,
        message: `Interface ${i.name} on ${d.name} sustained high utilization (${pct(util)}).`,
        recover: `Interface ${i.name} utilization back to normal.`,
      });
    }

    // Error burst — a jump in interface error counters since the last poll.
    const ekey = `${d.id}:${i.name}`;
    const cur = { rx: Number(i.rxErrors ?? 0), tx: Number(i.txErrors ?? 0) };
    const pe = prevErrors.get(ekey);
    prevErrors.set(ekey, cur);
    if (pe) {
      const dErr = (cur.rx >= pe.rx ? cur.rx - pe.rx : 0) + (cur.tx >= pe.tx ? cur.tx - pe.tx : 0);
      conditions.push({
        type: `iface_errors:${i.name}`, severity: "warning", transient: true,
        active: dErr > 100, metricValue: dErr,
        title: `Interface ${i.name} errors`,
        message: `Interface ${i.name} on ${d.name} logged ${dErr} new errors.`,
      });
    }
  }

  await applyConditions(io, d, conditions);
}

// UPS: power state + battery health + load + power quality. `below`/`above` apply
// hysteresis (trip at `on`, clear at `off`) using the prior condState to stop flapping.
async function checkUpsThresholds(io, d, sample) {
  const below = (type, v, on, off) => (v == null ? null : condState.get(`${d.id}:${type}`) ? v < off : v < on);
  const above = (type, v, on, off) => (v == null ? null : condState.get(`${d.id}:${type}`) ? v > off : v > on);
  const st = sample.batteryStatus; // RFC 1628: 2 normal, 3 low, 4 depleted

  await applyConditions(io, d, [
    { type: "ups_on_battery", severity: "critical",
      active: sample.onBattery == null ? null : sample.onBattery === true,
      title: "UPS on battery",
      message: `${d.name} switched to battery power — mains may be down.`,
      recover: `${d.name} returned to mains power.` },
    { type: "ups_battery_low", severity: "warning", metricValue: sample.batteryChargePct,
      active: below("ups_battery_low", sample.batteryChargePct, 20, 25),
      title: "UPS battery low", message: `${d.name} battery low: ${pct(sample.batteryChargePct)}.`,
      recover: `${d.name} battery charge recovered.` },
    { type: "ups_runtime_low", severity: "critical", metricValue: sample.runtimeRemainingMin,
      active: below("ups_runtime_low", sample.runtimeRemainingMin, 5, 8),
      title: "UPS runtime critical", message: `${d.name} runtime critically low: ${mins(sample.runtimeRemainingMin)}.`,
      recover: `${d.name} runtime recovered.` },
    { type: "ups_overload", severity: "warning", metricValue: sample.loadPct,
      active: above("ups_overload", sample.loadPct, 90, 85),
      title: "UPS overloaded", message: `${d.name} output overloaded: ${pct(sample.loadPct)} load.`,
      recover: `${d.name} load back to normal.` },
    { type: "ups_replace_battery", severity: "warning",
      active: st == null ? null : st === 3 || st === 4,
      title: "UPS battery fault",
      message: st === 4 ? `${d.name} battery depleted — replace battery.` : `${d.name} reports battery needs replacing.`,
      recover: `${d.name} battery status normal.` },
    { type: "ups_high_temp", severity: "warning", metricValue: sample.temperature,
      active: above("ups_high_temp", sample.temperature, 40, 37),
      title: "UPS temperature high", message: `${d.name} battery temperature high: ${degC(sample.temperature)}.`,
      recover: `${d.name} battery temperature normal.` },
    { type: "ups_input_voltage", severity: "warning", metricValue: sample.inputVoltage,
      active: !sample.inputVoltage ? null
        : condState.get(`${d.id}:ups_input_voltage`)
          ? sample.inputVoltage < 185 || sample.inputVoltage > 255
          : sample.inputVoltage < 180 || sample.inputVoltage > 260,
      title: "UPS input voltage abnormal",
      message: `${d.name} input voltage out of range: ${volts(sample.inputVoltage)} (nominal ~230 V).`,
      recover: `${d.name} input voltage normal.` },
  ]);
}

// ─── Per-device poll ────────────────────────────────────────────────────────────

async function pollRouter(io, d) {
  const labels = await loadInterfaceLabels(d.id);
  const sample = await collectRouter(d.id, connFor(d), labels); // throws if unreachable
  await setReachable(io, d, true);
  await writeNetworkSample(io, d, sample);
  await checkRouterThresholds(io, d, sample);
  latestNetwork.set(Number(d.id), {
    status: "Online",
    reachable: true,
    uptimeSeconds: sample.uptimeSeconds,
    cpuPercent: sample.cpuPercent,
    memPercent: sample.memPercent,
    interfaces: sample.interfaces.map((i) => ({
      name: i.name,
      locationLabel: i.locationLabel ?? "",
      linkUp: Boolean(i.linkUp),
      utilizationPct: i.utilizationPct ?? null,
      rxBytes: i.rxBytes != null ? String(i.rxBytes) : null, // BigInt → string (JSON-safe)
      txBytes: i.txBytes != null ? String(i.txBytes) : null,
    })),
  });
}

async function pollUps(io, d) {
  const sample = await collectUps(connFor(d)); // throws if unreachable
  await setReachable(io, d, true);
  await writeUpsSample(io, d, sample);
  await checkUpsThresholds(io, d, sample);
  latestUps.set(Number(d.id), {
    status: "Online",
    batteryChargePct: sample.batteryChargePct,
    runtimeRemainingMin: sample.runtimeRemainingMin,
    loadPct: sample.loadPct,
    inputVoltage: sample.inputVoltage,
    outputVoltage: sample.outputVoltage,
    batteryVoltage: sample.batteryVoltage,
    onBattery: sample.onBattery,
    temperature: sample.temperature,
  });
}

// ─── Main loop ──────────────────────────────────────────────────────────────────

let polling = false; // guard: skip a tick if the previous one is still running

async function pollAll(io) {
  if (polling) return;
  polling = true;
  try {
    const devices = await loadDevices();
    for (const d of devices) {
      try {
        if (d.type === "router") await pollRouter(io, d);
        else if (d.type === "ups") await pollUps(io, d);
      } catch (err) {
        // Unreachable / SNMP error for this device — mark offline, keep going.
        await setReachable(io, d, false);
      }
    }
  } catch (err) {
    console.error("[SNMP_POLLER] load error:", err.message);
  } finally {
    polling = false;
  }
}

// ─── Dashboard reads (GET /api/network, /api/ups) ───────────────────────────────

// All routers + their latest live values (status, interfaces, uptime). A router
// with no community string is returned with monitored=false so the UI can flag it
// as "not yet pollable" (it would need SNMP enabled or the ICMP fallback module).
async function getNetworkDevices() {
  const [rows] = await db.query(
    `SELECT d.device_id AS id, d.device_name AS name, d.ip_address AS ip,
            d.device_type AS type, d.status, d.location,
            n.snmp_community AS community, n.snmp_port AS snmpPort
       FROM devices d
       LEFT JOIN device_network n ON n.device_id = d.device_id
      WHERE d.device_type = 'router'
      ORDER BY d.device_name`,
  );
  return rows.map((r) => {
    const live = latestNetwork.get(Number(r.id));
    return {
      id: r.id,
      name: r.name,
      ip: r.ip,
      type: r.type,
      location: r.location,
      status: live?.status ?? labelStatus(r.status),
      reachable: live?.reachable ?? null,
      uptimeSeconds: live?.uptimeSeconds ?? null,
      cpuPercent: live?.cpuPercent ?? null,
      memPercent: live?.memPercent ?? null,
      interfaces: live?.interfaces ?? [],
      monitored: Boolean(r.community), // false → SNMP not configured (ping-only/unmanaged)
    };
  });
}

// All UPS units + their latest live values (battery %, runtime, load, on-battery).
// monitored=false for a usb/serial UPS — it can't be reached over SNMP.
async function getUpsDevices() {
  const [rows] = await db.query(
    `SELECT d.device_id AS id, d.device_name AS name, d.ip_address AS ip,
            d.status, d.location,
            u.brand, u.model, u.communication_type AS commType, u.battery_capacity AS batteryCapacity
       FROM devices d
       LEFT JOIN ups_details u ON u.device_id = d.device_id
      WHERE d.device_type = 'ups'
      ORDER BY d.device_name`,
  );
  return rows.map((r) => {
    const live = latestUps.get(Number(r.id));
    return {
      id: r.id,
      name: r.name,
      ip: r.ip,
      location: r.location,
      brand: r.brand,
      model: r.model,
      commType: r.commType,
      batteryCapacity: r.batteryCapacity,
      status: live?.status ?? labelStatus(r.status),
      batteryChargePct: live?.batteryChargePct ?? null,
      runtimeRemainingMin: live?.runtimeRemainingMin ?? null,
      loadPct: live?.loadPct ?? null,
      inputVoltage: live?.inputVoltage ?? null,
      outputVoltage: live?.outputVoltage ?? null,
      batteryVoltage: live?.batteryVoltage ?? null,
      onBattery: live?.onBattery ?? null,
      temperature: live?.temperature ?? null,
      monitored: ["snmp", "network"].includes(r.commType),
    };
  });
}

export default {
  pollAll,
  collectRouter,
  collectUps,
  loadDevices,
  getNetworkDevices,
  getUpsDevices,
};
