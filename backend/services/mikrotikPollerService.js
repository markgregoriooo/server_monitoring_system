import db from "../config/mysql.js";
import agentService from "./agentService.js";
import mikrotikClient from "./mikrotikClient.js";
import { writeNetworkSample } from "../handlers/networkMetricsHandler.js";
import { encrypt, decrypt } from "./mikrotikCrypto.js";
import deviceAlerts from "./deviceAlerts.js";

// ─── MikroTik poller: ONE campus router via the RouterOS API, pull-based ───────
//
// The sibling of snmpPollerService (data source B). Instead of SNMP it speaks the
// RouterOS API, and it produces the SAME sample shape → reuses writeNetworkSample()
// (router_metrics + network_traffic + the networkMetrics broadcast). Each building
// is a PORT, labeled via network_interfaces (interface_name → location_label).
// Because polling IS the heartbeat, there's no separate offline sweep.

const TIMEOUT_MS = Number(process.env.MIKROTIK_API_TIMEOUT_MS) || 5000;

// ─── In-memory state (resets on restart, repopulates next cycle) ───────────────
const prevIface = new Map(); // `${id}:${name}` -> { rx(BigInt), tx(BigInt), t(ms) }
const latest = new Map(); // id -> shaped summary for GET /api/mikrotik

const STATUS_LABEL = { online: "Online", offline: "Offline", warning: "Warning", maintenance: "Maintenance" };
const labelStatus = (s) => STATUS_LABEL[s] ?? "Offline";
const safeDecrypt = (v) => {
  if (!v) return "";
  try {
    return decrypt(v);
  } catch {
    return "";
  }
};

// ─── DB reads ──────────────────────────────────────────────────────────────────
async function loadDevices() {
  const [rows] = await db.query(
    `SELECT d.device_id AS id, d.device_name AS name, d.ip_address AS ip,
            d.device_type AS type, d.status, d.location,
            m.api_port AS apiPort, m.use_tls AS useTls,
            m.api_username AS apiUser, m.api_password AS apiPass, m.api_enabled AS apiEnabled
       FROM devices d
       JOIN mikrotik_devices m ON m.device_id = d.device_id
      WHERE d.device_type = 'mikrotik' AND m.api_enabled = 1`,
  );
  // Pollable = has an IP + a username configured.
  return rows.filter((r) => r.ip && r.apiUser);
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

const connFor = (d) => ({
  host: d.ip,
  port: d.apiPort || 8728,
  tls: Boolean(d.useTls),
  user: d.apiUser,
  password: safeDecrypt(d.apiPass),
  timeout: TIMEOUT_MS,
});

// ─── Utilization (per-interface delta vs the previous cycle) ───────────────────
function withUtilization(deviceId, ifaces) {
  const now = Date.now();
  return ifaces.map((i) => {
    const rx = i.rxBytes ?? 0n;
    const tx = i.txBytes ?? 0n;
    let utilizationPct = null;
    const key = `${deviceId}:${i.name}`;
    const prev = prevIface.get(key);
    if (prev) {
      const dt = (now - prev.t) / 1000;
      const dRx = rx >= prev.rx ? Number(rx - prev.rx) : 0; // discard wrap/reboot
      const dTx = tx >= prev.tx ? Number(tx - prev.tx) : 0;
      if (dt > 0 && i.speedMbps > 0) {
        const capacity = (i.speedMbps * 1e6) / 8; // Mbit/s → bytes/s
        utilizationPct = Math.min(100, ((dRx + dTx) / dt / capacity) * 100);
      }
    }
    prevIface.set(key, { rx, tx, t: now });
    return { ...i, utilizationPct };
  });
}

async function collect(d, labels) {
  const raw = await mikrotikClient.collect(connFor(d)); // throws if unreachable
  raw.interfaces = withUtilization(d.id, raw.interfaces).map((i) => ({
    ...i,
    locationLabel: labels[i.name] ?? "",
  }));
  return raw;
}

// ─── Status + threshold logging ────────────────────────────────────────────────
async function setReachable(io, d, online) {
  const id = Number(d.id);
  if (!online) latest.set(id, { status: "Offline", reachable: false, uptimeSeconds: null, interfaces: [] });
  const newStatus = online ? "online" : "offline";
  if (d.status === newStatus) return;
  try {
    await db.query(`UPDATE devices SET status = ?, updated_at = NOW() WHERE device_id = ?`, [newStatus, d.id]);
  } catch (err) {
    console.error("[MIKROTIK_POLLER] status update error:", err.message);
  }
  const log = await agentService.logDevice(
    d.id,
    online ? "info" : "warning",
    online ? "MikroTik reachable" : "MikroTik unreachable — no API response",
  );
  if (log) io?.emit("deviceLog", log);
  io?.emit("networkStatus", { id: d.id, status: online ? "Online" : "Offline" });
}

// Router CPU/mem + per-interface link utilization & interface-down alerting now
// lives in deviceAlerts.js (configurable alert_rules + REAL alerts: bell / email /
// Alerts page), shared with the generic SNMP poller — replacing the device-log-only
// interface-down check that used to be here.

// ─── Per-device poll ────────────────────────────────────────────────────────────
async function pollDevice(io, d) {
  const labels = await loadInterfaceLabels(d.id);
  const sample = await collect(d, labels); // throws if unreachable
  await setReachable(io, d, true);
  await writeNetworkSample(
    io,
    { id: d.id, name: d.name, ip: d.ip, type: d.type, location: d.location },
    sample,
  );
  await deviceAlerts.checkRouter(io, d, sample);

  latest.set(Number(d.id), {
    status: "Online",
    reachable: true,
    uptimeSeconds: sample.uptimeSeconds,
    cpuPercent: sample.cpuPercent,
    memPercent: sample.memPercent,
    connectedClients: sample.connectedClients,
    interfaces: sample.interfaces.map((i) => ({
      name: i.name,
      locationLabel: i.locationLabel ?? "",
      linkUp: Boolean(i.linkUp),
      utilizationPct: i.utilizationPct ?? null,
      rxBytes: i.rxBytes != null ? String(i.rxBytes) : null,
      txBytes: i.txBytes != null ? String(i.txBytes) : null,
    })),
  });

  try {
    await db.query(
      `UPDATE mikrotik_devices
          SET last_seen = NOW(),
              routeros_version = COALESCE(?, routeros_version),
              board_model = COALESCE(?, board_model)
        WHERE device_id = ?`,
      [sample.version ?? null, sample.boardName ?? null, d.id],
    );
  } catch (err) {
    console.error("[MIKROTIK_POLLER] last_seen update error:", err.message);
  }
}

// ─── Main loop ──────────────────────────────────────────────────────────────────
let polling = false;

async function pollAll(io) {
  if (polling) return;
  polling = true;
  try {
    const devices = await loadDevices();
    for (const d of devices) {
      try {
        await pollDevice(io, d);
      } catch {
        await setReachable(io, d, false); // unreachable — mark offline, keep going
      }
    }
  } catch (err) {
    console.error("[MIKROTIK_POLLER] load error:", err.message);
  } finally {
    polling = false;
  }
}

// ─── Dashboard reads (GET /api/mikrotik) ────────────────────────────────────────
async function getMikrotikDevices() {
  const [rows] = await db.query(
    `SELECT d.device_id AS id, d.device_name AS name, d.ip_address AS ip,
            d.device_type AS type, d.status, d.location,
            m.routeros_version AS routerosVersion, m.board_model AS boardModel,
            m.api_port AS apiPort, m.use_tls AS useTls,
            m.api_username AS apiUser, m.api_enabled AS apiEnabled
       FROM devices d
       LEFT JOIN mikrotik_devices m ON m.device_id = d.device_id
      WHERE d.device_type = 'mikrotik'
      ORDER BY d.device_name`,
  );
  return rows.map((r) => {
    const live = latest.get(Number(r.id));
    return {
      id: r.id,
      name: r.name,
      ip: r.ip,
      type: r.type,
      location: r.location,
      routerosVersion: r.routerosVersion,
      boardModel: r.boardModel,
      apiPort: r.apiPort,
      useTls: Boolean(r.useTls),
      apiUsername: r.apiUser, // username only — NEVER the password
      status: live?.status ?? labelStatus(r.status),
      reachable: live?.reachable ?? null,
      uptimeSeconds: live?.uptimeSeconds ?? null,
      cpuPercent: live?.cpuPercent ?? null,
      memPercent: live?.memPercent ?? null,
      connectedClients: live?.connectedClients ?? null,
      interfaces: live?.interfaces ?? [],
      monitored: Boolean(r.apiUser && r.apiEnabled),
    };
  });
}

// ─── Admin: save connection details (encrypts the password) ─────────────────────
async function saveConnection(id, { apiPort, useTls, apiUsername, apiPassword } = {}) {
  const fields = [];
  const vals = [];
  if (apiPort != null) {
    fields.push("api_port = ?");
    vals.push(Number(apiPort));
  }
  if (useTls != null) {
    fields.push("use_tls = ?");
    vals.push(useTls ? 1 : 0);
  }
  if (apiUsername != null) {
    fields.push("api_username = ?");
    vals.push(String(apiUsername));
  }
  if (apiPassword) {
    fields.push("api_password = ?");
    vals.push(encrypt(String(apiPassword))); // stored encrypted (base64)
  }
  if (!fields.length) return { ok: false, error: "Nothing to update." };
  vals.push(id);
  const [r] = await db.query(
    `UPDATE mikrotik_devices SET ${fields.join(", ")}, updated_at = NOW() WHERE device_id = ?`,
    vals,
  );
  return { ok: r.affectedRows > 0 };
}

// ─── Admin: test connection ──────────────────────────────────────────────────────
async function testConnection(id) {
  const [[row]] = await db.query(
    `SELECT d.ip_address AS ip, m.api_port AS apiPort, m.use_tls AS useTls,
            m.api_username AS apiUser, m.api_password AS apiPass
       FROM devices d JOIN mikrotik_devices m ON m.device_id = d.device_id
      WHERE d.device_id = ? AND d.device_type = 'mikrotik'`,
    [id],
  );
  if (!row) return { ok: false, error: "MikroTik device not found." };
  try {
    const info = await mikrotikClient.testConnection({
      host: row.ip,
      port: row.apiPort || 8728,
      tls: Boolean(row.useTls),
      user: row.apiUser,
      password: safeDecrypt(row.apiPass),
      timeout: TIMEOUT_MS,
    });
    return { ok: true, ...info };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Admin: register a new MikroTik (device + connection rows) ──────────────────
async function createDevice({ name, ip, location, apiPort, useTls, apiUsername, apiPassword } = {}) {
  const nm = String(name ?? "").trim();
  if (!nm) return { ok: false, error: "Name is required." };
  if (!String(ip ?? "").trim()) return { ok: false, error: "IP address is required." };
  const loc = String(location ?? "").trim() || "Server Room";
  const [r] = await db.query(
    `INSERT INTO devices (ip_address, device_name, device_type, status, location)
     VALUES (?, ?, 'mikrotik', 'offline', ?)`,
    [String(ip).trim(), nm, loc],
  );
  const id = r.insertId;
  await db.query(
    `INSERT INTO mikrotik_devices (device_id, api_port, use_tls, api_username, api_password, api_enabled)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [
      id,
      apiPort != null ? Number(apiPort) : 8728,
      useTls ? 1 : 0,
      apiUsername ? String(apiUsername).trim() : null,
      apiPassword ? encrypt(String(apiPassword)) : null,
    ],
  );
  return { ok: true, id };
}

export default {
  pollAll,
  getMikrotikDevices,
  createDevice,
  saveConnection,
  testConnection,
  loadDevices,
  collect,
};
