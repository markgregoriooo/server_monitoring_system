import db from "../config/mysql.js";
import client, { SYS_OID, IF_OID, IF_OPER_STATUS, UPS_OID, isOnBattery } from "./snmpClient.js";
import agentService from "./agentService.js";
import { writeNetworkSample } from "../handlers/networkMetricsHandler.js";
import { writeUpsSample } from "../handlers/upsMetricsHandler.js";
import deviceAlerts from "./deviceAlerts.js";

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
  // Real alert (bell/email/Alerts page): raise on the offline transition, auto-resolve
  // on recovery. Severity is derived from device type (router critical, UPS warning).
  await deviceAlerts.checkReachability(d, online);
}

// Threshold + event alerting (router CPU/mem/clients, link utilization + interface
// down, UPS charge/runtime/load + on-battery) now lives in deviceAlerts.js, which
// drives the configurable alert_rules + raises REAL alerts (bell / email / Alerts
// page) instead of the device-log-only checks that used to be here.

// ─── Per-device poll ────────────────────────────────────────────────────────────

async function pollRouter(io, d) {
  const labels = await loadInterfaceLabels(d.id);
  const sample = await collectRouter(d.id, connFor(d), labels); // throws if unreachable
  await setReachable(io, d, true);
  await writeNetworkSample(io, d, sample);
  await deviceAlerts.checkRouter(io, d, sample);
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
  await deviceAlerts.checkUps(io, d, sample);
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
