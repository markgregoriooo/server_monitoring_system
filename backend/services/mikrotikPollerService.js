import db from "../config/mysql.js";
import agentService from "./agentService.js";
import mikrotikClient from "./mikrotikClient.js";
import { writeNetworkSample } from "../handlers/networkMetricsHandler.js";
import { encrypt, decrypt } from "./mikrotikCrypto.js";
import deviceAlerts from "./deviceAlerts.js";
import alertBandState from "./alertBandState.js";

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
  // Real alert (bell/email/Alerts page): raise on the offline transition, auto-resolve
  // on recovery. The campus MikroTik carries all building traffic → critical.
  await deviceAlerts.checkReachability(d, online, { label: "MikroTik", severity: "critical" });
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
      rxErrors: i.rxErrors ?? 0,
      txErrors: i.txErrors ?? 0,
      speedMbps: i.speedMbps ?? null,
      clients: i.clients ?? null,
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
      } catch (err) {
        // Log the reason. A bare catch here made every failure look identical to
        // "unreachable", so a router that answers fine but rejects one API command
        // silently showed as Offline with nothing to debug from.
        console.error(
          `[MIKROTIK_POLLER] poll failed for ${d.name} (${d.ip}):`,
          err?.message ?? err,
        );
        await setReachable(io, d, false); // treat as offline, keep going
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
// `override` carries credentials straight from the admin form, so a login can be
// verified BEFORE it is persisted. Previously this only read the stored row, which
// meant you had to save a possibly-wrong password to find out it was wrong.
//   id = null            → fully ad-hoc test (the Add form, device doesn't exist yet)
//   id + override        → stored device, but test what's currently typed
//   id + empty override  → stored device, test what's saved (original behaviour)
// A blank `apiPassword` in an override means "keep using the stored one".
async function testConnection(id, override = {}) {
  const o = override ?? {};
  let conn;

  if (id == null) {
    conn = {
      host: String(o.ip ?? "").trim(),
      port: Number(o.apiPort) || 8728,
      tls: Boolean(o.useTls),
      user: String(o.apiUsername ?? "").trim(),
      password: String(o.apiPassword ?? ""),
      timeout: TIMEOUT_MS,
    };
  } else {
    const [[row]] = await db.query(
      `SELECT d.ip_address AS ip, m.api_port AS apiPort, m.use_tls AS useTls,
              m.api_username AS apiUser, m.api_password AS apiPass
         FROM devices d JOIN mikrotik_devices m ON m.device_id = d.device_id
        WHERE d.device_id = ? AND d.device_type = 'mikrotik'`,
      [id],
    );
    if (!row) return { ok: false, error: "MikroTik device not found." };
    conn = {
      host: String(o.ip ?? row.ip ?? "").trim(),
      port: o.apiPort != null ? Number(o.apiPort) || 8728 : row.apiPort || 8728,
      tls: o.useTls != null ? Boolean(o.useTls) : Boolean(row.useTls),
      user: String(o.apiUsername ?? row.apiUser ?? "").trim(),
      password: o.apiPassword ? String(o.apiPassword) : safeDecrypt(row.apiPass),
      timeout: TIMEOUT_MS,
    };
  }

  if (!conn.host) return { ok: false, error: "IP address is required." };
  if (!conn.user) return { ok: false, error: "Username is required." };

  try {
    const info = await mikrotikClient.testConnection(conn);
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

  // Names must be unique among MikroTiks. Two identically-named cards are
  // indistinguishable in the list apart from their IP line — which is exactly how one
  // physical router ends up registered twice, double-polled and double-alerting.
  // LOWER() is explicit rather than relying on the table's case-insensitive collation.
  const [dupe] = await db.query(
    `SELECT device_id FROM devices
      WHERE device_type = 'mikrotik' AND LOWER(device_name) = LOWER(?)
      LIMIT 1`,
    [nm],
  );
  if (dupe.length) {
    return { ok: false, status: 409, error: `A MikroTik named "${nm}" already exists.` };
  }
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

// ─── Port labels (network_interfaces) ───────────────────────────────────────────
// One row per labelled port. Rows are OPTIONAL: a port with no row simply shows its
// raw RouterOS name. Until now these could only be seeded by hand in SQL.

async function getInterfaces(deviceId) {
  const [rows] = await db.query(
    `SELECT interface_name AS name, location_label AS label
       FROM network_interfaces
      WHERE device_id = ?
      ORDER BY interface_name`,
    [Number(deviceId)],
  );
  return rows.map((r) => ({ name: r.name, label: r.label ?? "" }));
}

// Upsert one label per port. There is no UNIQUE index on (device_id, interface_name),
// so this checks before writing rather than relying on ON DUPLICATE KEY. A blank label
// DELETES the row — "no label" is the absence of a row, so the table never accumulates
// empty strings.
async function saveInterfaces(deviceId, labels) {
  const id = Number(deviceId);
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid device id." };
  if (!Array.isArray(labels)) return { ok: false, error: "labels must be an array." };

  for (const entry of labels) {
    const name = String(entry?.name ?? "").trim();
    if (!name || name.length > 50) continue;
    const label = String(entry?.label ?? "").trim().slice(0, 100);

    if (!label) {
      await db.query(
        `DELETE FROM network_interfaces WHERE device_id = ? AND interface_name = ?`,
        [id, name],
      );
      continue;
    }
    const [existing] = await db.query(
      `SELECT id FROM network_interfaces WHERE device_id = ? AND interface_name = ? LIMIT 1`,
      [id, name],
    );
    if (existing.length) {
      await db.query(
        `UPDATE network_interfaces SET location_label = ?, updated_at = NOW() WHERE id = ?`,
        [label, existing[0].id],
      );
    } else {
      await db.query(
        `INSERT INTO network_interfaces (device_id, interface_name, location_label, is_active)
         VALUES (?, ?, ?, 1)`,
        [id, name, label],
      );
    }
  }

  // Reflect the new labels in the cached view immediately — otherwise they wouldn't
  // appear until the next poll, up to MIKROTIK_POLL_INTERVAL_MS later.
  const cached = latest.get(id);
  if (cached?.interfaces?.length) {
    const map = await loadInterfaceLabels(id);
    cached.interfaces = cached.interfaces.map((i) => ({ ...i, locationLabel: map[i.name] ?? "" }));
  }
  return { ok: true };
}

// ─── Admin: decommission a MikroTik ─────────────────────────────────────────────
// Deleting the `devices` row cascades to mikrotik_devices, network_interfaces,
// device_logs and alerts (all FK ON DELETE CASCADE). Also drops this device's
// in-memory poller state so a later id reuse can't inherit stale counters or alert
// bands. InfluxDB history is left intact (orphaned by its device_id tag).
// Mirrors snmpPollerService.removeDevice on the router/UPS side.
async function removeDevice(id) {
  const deviceId = Number(id);
  if (!Number.isInteger(deviceId)) return false;

  const [result] = await db.query(
    `DELETE FROM devices WHERE device_id = ? AND device_type = 'mikrotik'`,
    [deviceId],
  );
  if (result.affectedRows === 0) return false;

  latest.delete(deviceId);
  for (const key of prevIface.keys()) {
    if (key.startsWith(`${deviceId}:`)) prevIface.delete(key);
  }
  alertBandState.resetDevice(deviceId);
  return true;
}

export default {
  pollAll,
  getMikrotikDevices,
  createDevice,
  saveConnection,
  testConnection,
  removeDevice,
  getInterfaces,
  saveInterfaces,
  loadDevices,
  collect,
};
