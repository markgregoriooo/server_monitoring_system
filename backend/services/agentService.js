import crypto from "crypto";
import db from "../config/mysql.js";
import notificationService from "./notificationService.js";
import alertRulesService from "./alertRulesService.js";
import alertsService from "./alertsService.js";
import alertBandState from "./alertBandState.js";

// ─── All Go-agent + server-device DB logic (devices + server_specs +
//     device_network + agent_tokens). Mirrors the airconService pattern. ───────

const STATUS_LABEL = {
  online: "Online",
  offline: "Offline",
  warning: "Warning",
  maintenance: "Maintenance",
};
const label = (s) => STATUS_LABEL[s] ?? s;

// Derive a /24 segment string from an IPv4 address ("" if unknown).
function networkSegment(ip) {
  const m = typeof ip === "string" && ip.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : "";
}

// A server counts as offline when no metric POST has refreshed its last_seen
// within this window. Agents post every ~10s, so 30s tolerates ~three missed cycles
// before the badge flips to Offline (one dropped POST won't cause a false alarm).
const OFFLINE_AFTER_SEC = 30;

// In-memory cache of each server's latest live metrics (cpu/mem/disk %, uptime),
// so GET /api/servers can render real numbers immediately after a browser refresh
// instead of waiting up to one agent interval (10s) for the next socket push.
// Resets on backend restart, then repopulates on the next metric POST.
const latestMetrics = new Map(); // device_id (number) -> { cpu, memory, diskUsed, uptime }

function cacheLatest(deviceId, live) {
  latestMetrics.set(Number(deviceId), live);
}

// True when a server's last heartbeat is older than the offline window (or never).
function isStale(lastSeen) {
  if (!lastSeen) return true;
  return Date.now() - new Date(lastSeen).getTime() > OFFLINE_AFTER_SEC * 1000;
}

// Overlay cached live metrics + label the status for a server DB row. A server
// whose last_seen has gone stale reads as Offline with zeroed live metrics even
// if devices.status still says 'online' (the sweep may not have run yet) — so a
// GET right after a backend restart is already correct, not falsely Online.
function withLive(r) {
  const offline = r.status === "offline" || isStale(r.lastSeen);
  const live = offline ? undefined : latestMetrics.get(r.id);
  return {
    ...r,
    status: offline ? "Offline" : label(r.status),
    cpu: live?.cpu ?? 0,
    memory: live?.memory ?? 0,
    diskUsed: live?.diskUsed ?? 0,
    // A down server has no current uptime — don't surface the last-known value,
    // it reads as if the box were still up. Live rows use the cached label.
    uptime: offline ? null : (live?.uptime ?? r.uptime ?? null),
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

// First-run enrollment. Creates devices + server_specs + device_network +
// agent_tokens rows in one transaction. Idempotent per NIC: a host that
// re-registers with the same MAC reuses its existing enrollment (so an agent
// restart before approval does not spawn duplicate pending devices).
async function register(host) {
  const mac = host.mac_address || null;

  if (mac) {
    const [[existing]] = await db.query(
      `SELECT t.token AS pendingToken, t.device_id AS deviceId
         FROM device_network n
         JOIN agent_tokens t ON t.device_id = n.device_id
        WHERE n.mac_address = ? AND t.status IN ('pending', 'approved')
        ORDER BY t.id DESC
        LIMIT 1`,
      [mac],
    );
    if (existing) {
      // Same NIC re-registering: refresh specs + network info (IP/gateway/DNS may
      // have changed) without disturbing the token or approval state.
      await refreshHostInfo(existing.deviceId, host);
      return { pendingToken: existing.pendingToken, deviceId: existing.deviceId, reused: true };
    }
  }

  const pendingToken = crypto.randomBytes(24).toString("hex");
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [dev] = await conn.query(
      `INSERT INTO devices (ip_address, device_name, device_type, status, location)
       VALUES (?, ?, 'server', 'pending', ?)`,
      [host.ip_address || null, host.hostname || "unknown-server", host.location || "CSPC-ICTU Server Room"],
    );
    const deviceId = dev.insertId;

    await conn.query(
      `INSERT INTO server_specs
         (device_id, os, kernel, cores, architecture,
          memory_total_mb, disk_total_gb, agent_version, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        deviceId,
        host.platform || host.os || "unknown",
        host.kernel_version || "",
        host.cores || 0,
        host.arch || "",
        Math.round(host.memory_total_mb || 0),
        Math.round(host.disk_total_gb || 0),
        host.agent_version || "",
      ],
    );

    await conn.query(
      `INSERT INTO device_network (device_id, gateway, dns, network_segment, mac_address)
       VALUES (?, ?, ?, ?, ?)`,
      [deviceId, host.gateway || "", host.dns || "", networkSegment(host.ip_address), mac],
    );

    await conn.query(
      `INSERT INTO agent_tokens (device_id, token, status, last_used_at)
       VALUES (?, ?, 'pending', NOW())`,
      [deviceId, pendingToken],
    );

    await conn.commit();
    return { pendingToken, deviceId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Re-register from a known NIC: refresh specs + network info (IP, gateway, DNS,
// cores, etc.) in case they changed. Leaves the token and approval untouched.
async function refreshHostInfo(deviceId, host) {
  await db.query(`UPDATE devices SET ip_address = ?, updated_at = NOW() WHERE device_id = ?`, [
    host.ip_address || null,
    deviceId,
  ]);
  await db.query(
    `UPDATE server_specs
        SET os = ?, kernel = ?, cores = ?, architecture = ?,
            memory_total_mb = ?, disk_total_gb = ?, agent_version = ?
      WHERE device_id = ?`,
    [
      host.platform || host.os || "unknown",
      host.kernel_version || "",
      host.cores || 0,
      host.arch || "",
      Math.round(host.memory_total_mb || 0),
      Math.round(host.disk_total_gb || 0),
      host.agent_version || "",
      deviceId,
    ],
  );
  await db.query(
    `UPDATE device_network
        SET gateway = ?, dns = ?, network_segment = ?, mac_address = ?
      WHERE device_id = ?`,
    [host.gateway || "", host.dns || "", networkSegment(host.ip_address), host.mac_address || null, deviceId],
  );
}

// Agent polls this with its pending token until status flips to approved.
async function getStatusByPendingToken(token) {
  const [[row]] = await db.query(
    `SELECT status, approved_token, device_id FROM agent_tokens WHERE token = ? LIMIT 1`,
    [token],
  );
  if (!row) return null;
  return {
    status: row.status,
    approved_token: row.approved_token || "",
    device_id: row.device_id,
  };
}

// ─── Admin approval ───────────────────────────────────────────────────────────

async function listPending() {
  const [rows] = await db.query(
    `SELECT d.device_id AS id, d.device_name AS name, d.ip_address AS ip, d.location,
            s.os, s.architecture AS arch, s.cores, s.agent_version,
            n.mac_address AS mac, t.created_at AS requestedAt
       FROM devices d
       JOIN agent_tokens t ON t.device_id = d.device_id AND t.status = 'pending'
       LEFT JOIN server_specs s   ON s.device_id = d.device_id
       LEFT JOIN device_network n ON n.device_id = d.device_id
      WHERE d.device_type = 'server'
      ORDER BY t.created_at DESC`,
  );
  return rows;
}

// Generate the permanent token and flip statuses. Returns null if there is no
// pending enrollment for that device (already approved / unknown id).
async function approve(deviceId) {
  const approvedToken = "AGT-" + crypto.randomBytes(24).toString("hex");
  const [result] = await db.query(
    `UPDATE agent_tokens
        SET approved_token = ?, status = 'approved', approved_at = NOW()
      WHERE device_id = ? AND status = 'pending'`,
    [approvedToken, deviceId],
  );
  if (result.affectedRows === 0) return null;

  // Leave the device 'offline' until its agent actually reports. The first metric
  // POST then transitions offline→online (recordHeartbeat → cameOnline), which fires
  // the "Server online" alert — so a brand-new connect is announced just like a
  // reconnect. The offline sweep only touches status='online' rows, so a not-yet-
  // reporting approved server is never falsely alerted as "offline".
  await db.query(`UPDATE devices SET status = 'offline' WHERE device_id = ?`, [deviceId]);
  const [[dev]] = await db.query(`SELECT device_name FROM devices WHERE device_id = ?`, [deviceId]);
  return { approvedToken, deviceName: dev?.device_name };
}

// Reject a still-pending enrollment by deleting the device entirely (its
// server_specs / device_network / agent_tokens cascade away). This removes it
// from the pending list and lets that machine re-enroll cleanly later. Only
// acts on pending enrollments — never on an already-approved server.
async function reject(deviceId) {
  const [[tok]] = await db.query(
    `SELECT id FROM agent_tokens WHERE device_id = ? AND status = 'pending' LIMIT 1`,
    [deviceId],
  );
  if (!tok) return false;
  await db.query(`DELETE FROM devices WHERE device_id = ?`, [deviceId]);
  latestMetrics.delete(Number(deviceId));
  alertBandState.resetDevice(deviceId);
  return true;
}

// ─── Metric ingestion auth + heartbeat ────────────────────────────────────────

// Used by agentAuthMiddleware. Returns the device identity for a valid,
// approved token, or null. Best-effort bumps last_used_at without blocking.
async function validateToken(token) {
  const [[row]] = await db.query(
    `SELECT t.device_id, d.device_name, d.display_name, d.ip_address, d.location, s.os
       FROM agent_tokens t
       JOIN devices d ON d.device_id = t.device_id
       LEFT JOIN server_specs s ON s.device_id = t.device_id
      WHERE t.approved_token = ? AND t.status = 'approved'
      LIMIT 1`,
    [token],
  );
  if (!row) return null;

  db.query(`UPDATE agent_tokens SET last_used_at = NOW() WHERE approved_token = ?`, [token]).catch(
    () => {},
  );
  return row;
}

// Called on each metric POST: mark the server online and refresh last_seen/uptime.
// Returns { cameOnline } so the caller can log an offline→online transition.
async function recordHeartbeat(deviceId, uptimeLabel) {
  const [[row]] = await db.query(`SELECT status FROM devices WHERE device_id = ? LIMIT 1`, [deviceId]);
  const cameOnline = row && row.status !== "online";

  await db.query(`UPDATE devices SET status = 'online', updated_at = NOW() WHERE device_id = ?`, [
    deviceId,
  ]);
  await db.query(`UPDATE server_specs SET last_seen = NOW(), uptime = ? WHERE device_id = ?`, [
    uptimeLabel,
    deviceId,
  ]);
  return { cameOnline: Boolean(cameOnline) };
}

// ─── Device event log (device_logs) ───────────────────────────────────────────

// Best-effort insert of one device event. Returns the row shape for live emit,
// or null on failure (logging must never break a metric POST).
async function logDevice(deviceId, level, message) {
  try {
    await db.query(`INSERT INTO device_logs (device_id, log_level, message) VALUES (?, ?, ?)`, [
      deviceId,
      level,
      message,
    ]);
    return { device_id: Number(deviceId), log_level: level, message, recorded_at: new Date().toISOString() };
  } catch (err) {
    console.error("[device_logs] insert error:", err.message);
    return null;
  }
}

async function getDeviceLogs(deviceId, limit = 50) {
  const n = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const [rows] = await db.query(
    `SELECT log_level, message, recorded_at
       FROM device_logs
      WHERE device_id = ?
      ORDER BY recorded_at DESC, device_log_id DESC
      LIMIT ${n}`,
    [deviceId],
  );
  return rows;
}

// Threshold alerting — thresholds are now CONFIGURABLE (alert_rules), resolved per
// server (per-device override else global). We track the last band per device+metric
// and act only on the ONSET of a worse band; alertRulesService.nextBand applies
// hysteresis so a value flapping at a boundary doesn't churn device_logs. With no
// matching rule the band is "normal" (rules-only → silent). See alertRulesService.js.
const SEV_RANK = alertRulesService.SEV_RANK;
const METRIC_LABEL = { cpu: "CPU", mem: "Memory", disk: "Disk" };

// Returns the device-log rows created this cycle (for live emit).
async function checkThresholds(deviceId, metrics) {
  const id = Number(deviceId);
  const events = [];

  for (const key of ["cpu", "mem", "disk"]) {
    const v = metrics[key];
    if (typeof v !== "number" || Number.isNaN(v)) continue;
    const label = METRIC_LABEL[key];

    // Current band lives in the shared alertBandState so the lifecycle (resolve /
    // auto-resolve) can re-arm it — a still-breaching metric re-alerts after a resolve.
    const prevBand = alertBandState.getBand(id, key);
    const rules = await alertRulesService.getEffectiveRules(id, key);
    const { band, rule } = alertRulesService.nextBand(rules, v, prevBand);
    alertBandState.setBand(id, key, band); // always track state (so a later breach re-arms)…

    // Recovery: the metric returned to normal → auto-resolve its open alerts.
    if (band === "normal" && prevBand !== "normal") {
      await alertsService.autoResolveMetric(id, key);
    }

    // …but only LOG + alert the ONSET of a worse band — not steady-state or
    // recoveries — to keep device_logs lean and the bell quiet.
    if (SEV_RANK[band] <= SEV_RANK[prevBand]) continue;

    const pct = Math.round(v);
    const word = band === "critical" ? "critical" : band === "warning" ? "high" : band;
    events.push(await logDevice(id, band, `${label} ${word}: ${pct}%`));
    await notificationService.raiseAlert({
      deviceId: id, type: key, severity: band,
      title: `${label} ${word}`, message: `${label} ${word}: ${pct}%`,
      metricValue: v, alertRuleId: rule?.alert_rule_id ?? null,
    });
  }

  return events.filter(Boolean);
}

// ─── Offline sweep ────────────────────────────────────────────────────────────

// Agents POST every ~10s and refresh last_seen; nothing else flips a dead agent's
// server to 'offline'. This finds approved servers still marked 'online' whose
// last_seen has gone stale, marks them offline, and returns only the rows that
// JUST transitioned — so the caller can push a live status update + a device log.
// Idempotent: rows already 'offline' are skipped, so it logs the event once.
async function sweepOffline() {
  const [stale] = await db.query(
    `SELECT d.device_id AS id, d.device_name AS name
       FROM devices d
       JOIN agent_tokens t        ON t.device_id = d.device_id AND t.status = 'approved'
       LEFT JOIN server_specs s   ON s.device_id = d.device_id
      WHERE d.device_type = 'server'
        AND d.status = 'online'
        AND (s.last_seen IS NULL OR s.last_seen < (NOW() - INTERVAL ${OFFLINE_AFTER_SEC} SECOND))`,
  );
  if (stale.length === 0) return [];

  const ids = stale.map((r) => r.id);
  await db.query(
    `UPDATE devices SET status = 'offline', updated_at = NOW()
      WHERE device_id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );

  const out = [];
  for (const r of stale) {
    latestMetrics.delete(Number(r.id));
    alertBandState.resetDevice(r.id); // re-arm threshold logging for when it returns
    const log = await logDevice(r.id, "warning", "Server went offline — no metrics received");
    out.push({ id: Number(r.id), name: r.name, log });
  }
  return out;
}

// ─── Dashboard reads ──────────────────────────────────────────────────────────

// Only servers with an APPROVED agent token belong in the dashboard list. The
// INNER JOIN on agent_tokens excludes pending (awaiting approval) and rejected
// enrollments, regardless of the device's online/offline status.
const SERVER_SELECT = `
  SELECT d.device_id AS id,
         COALESCE(NULLIF(d.display_name, ''), d.device_name) AS name,
         d.device_name AS hostname, d.display_name AS displayName,
         d.ip_address AS ip, d.status,
         d.location, s.os, s.kernel, s.cores, s.architecture AS arch,
         s.memory_total_mb AS memoryTotalMB, s.disk_total_gb AS diskTotalGB,
         s.agent_version AS agentVersion, s.uptime, s.last_seen AS lastSeen,
         n.gateway, n.dns, n.network_segment AS region, n.mac_address AS mac
    FROM devices d
    JOIN agent_tokens t        ON t.device_id = d.device_id AND t.status = 'approved'
    LEFT JOIN server_specs s   ON s.device_id = d.device_id
    LEFT JOIN device_network n ON n.device_id = d.device_id`;

async function getServers() {
  const [rows] = await db.query(
    `${SERVER_SELECT}
      WHERE d.device_type = 'server'
      ORDER BY d.device_name`,
  );
  return rows.map(withLive);
}

async function getServerById(id) {
  const [[row]] = await db.query(`${SERVER_SELECT} WHERE d.device_id = ? AND d.device_type = 'server'`, [
    id,
  ]);
  if (!row) return null;
  return withLive(row);
}

// Decommission a server: delete the devices row. server_specs, device_network
// and agent_tokens cascade-delete via their FKs, which also revokes the token
// (a still-running agent's next POST then fails agentAuth). Influx history is
// left intact. Returns false if no such server.
async function removeServer(id) {
  const [result] = await db.query(
    `DELETE FROM devices WHERE device_id = ? AND device_type = 'server'`,
    [id],
  );
  if (result.affectedRows > 0) {
    latestMetrics.delete(Number(id));
    alertBandState.resetDevice(id);
  }
  return result.affectedRows > 0;
}

// Set (or clear) a server's admin display name. An empty/blank value clears it
// (display_name → NULL) so the UI falls back to the real hostname. Never touches
// device_name (the hostname), so it survives agent re-registration. Returns the
// fresh { name (effective), hostname, displayName } for the live emit, or null if
// there is no such server. Existence is checked separately so renaming a server to
// its CURRENT label (MySQL UPDATE affectedRows = 0 on an unchanged value) is not
// mistaken for "not found".
async function renameServer(id, displayName) {
  const [[exists]] = await db.query(
    `SELECT device_id FROM devices WHERE device_id = ? AND device_type = 'server' LIMIT 1`,
    [id],
  );
  if (!exists) return null;

  const value = typeof displayName === "string" && displayName.trim() ? displayName.trim() : null;
  await db.query(`UPDATE devices SET display_name = ?, updated_at = NOW() WHERE device_id = ?`, [
    value,
    id,
  ]);

  const [[row]] = await db.query(
    `SELECT COALESCE(NULLIF(display_name, ''), device_name) AS name,
            device_name AS hostname, display_name AS displayName
       FROM devices WHERE device_id = ?`,
    [id],
  );
  return row;
}

const agentService = {
  register,
  getStatusByPendingToken,
  listPending,
  approve,
  reject,
  validateToken,
  recordHeartbeat,
  cacheLatest,
  logDevice,
  getDeviceLogs,
  checkThresholds,
  sweepOffline,
  getServers,
  getServerById,
  removeServer,
  renameServer,
};

export default agentService;
