import crypto from "crypto";
import db from "../config/mysql.js";
import notificationService from "./notificationService.js";
import alertRulesService from "./alertRulesService.js";
import alertsService from "./alertsService.js";
import alertBandState from "./alertBandState.js";
import {
  DEFAULT_INTERVAL_SEC,
  OFFLINE_FLOOR_SEC,
  offlineWindowSec,
  HEARTBEAT_TIMEOUT_SEC,
  SHUTDOWN_REASONS,
  staleBeats,
  inShutdownHold,
  shutdownReason,
} from "./serverMetricUtils.js";
// Shared with the SNMP poller so both write network_segment the same way.
import { networkSegment } from "./snmpUtils.js";
import { logDevice, getDeviceLogs } from "./deviceLogs.js";
// Same hash as the install keys (SHA-256; see migrations/2026-08-25_agent_token_hash.sql).
import { hashKey } from "./installKeyUtils.js";
// AES-256-GCM, only for the token copy that must be readable again (see approve()).
import secretCrypto from "./secretCrypto.js";
import { describeError, unavailable } from "../utils/httpError.js";

// ─── All Go-agent + server-device DB logic (devices + server_specs +
//     device_network + agent_tokens). Mirrors the airconService pattern. ───────

const STATUS_LABEL = {
  online: "Online",
  offline: "Offline",
  warning: "Warning",
  maintenance: "Maintenance",
};
const label = (s) => STATUS_LABEL[s] ?? s;

// Offline = no metric POST within 3 of the agent's intervals, floored by
// SERVER_OFFLINE_AFTER_SEC.
const OFFLINE_SQL_WINDOW = `GREATEST(${OFFLINE_FLOOR_SEC}, COALESCE(s.metric_interval_sec, ${DEFAULT_INTERVAL_SEC}) * 3)`;

// Latest live metrics per server, so GET /api/servers shows numbers right after a
// refresh. Lost on restart, refilled by the next metric POST.
const latestMetrics = new Map(); // device_id (number) -> { cpu, memory, diskUsed, uptime, volumes }

function cacheLatest(deviceId, live) {
  latestMetrics.set(Number(deviceId), live);
}

// True when the last heartbeat is older than this agent's offline window (or never).
function isStale(lastSeen, intervalSec) {
  if (!lastSeen) return true;
  return Date.now() - new Date(lastSeen).getTime() > offlineWindowSec(intervalSec) * 1000;
}

// Add cached live metrics and a status label to a server row. A stale server reads
// as Offline even before the sweep runs. Maintenance outranks staleness.
function withLive(r) {
  const maintenance = r.status === "maintenance";
  const offline = !maintenance && (r.status === "offline" || isStale(r.lastSeen, r.metricIntervalSec));
  const live = offline ? undefined : latestMetrics.get(r.id);
  // Never reported since approval (last_seen NULL): likely a wrong URL, a firewall, or
  // a service that never started. Not the same as a server that went down.
  const awaitingFirstReport = !maintenance && r.lastSeen == null;
  return {
    ...r,
    awaitingFirstReport,
    status: maintenance ? "Maintenance" : offline ? "Offline" : label(r.status),
    cpu: live?.cpu ?? 0,
    memory: live?.memory ?? 0,
    diskUsed: live?.diskUsed ?? 0,
    processCount: live?.processCount ?? null,
    // Every fixed volume from the last sample; empty until the next post after a restart.
    volumes: live?.volumes ?? [],
    // A down server has no current uptime.
    uptime: offline ? null : (live?.uptime ?? r.uptime ?? null),
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

// Find a returning machine's enrollment: by MAC first, then by hostname.
// 'revoked' is included so a re-enrolled machine keeps its device_id and history.
// Returns { deviceId, status, tokenId, installKeyId } or null.
async function findExistingEnrollment(mac, hostname) {
  const LIVE = "('pending', 'approved', 'revoked')";
  if (mac) {
    const [[byMac]] = await db.query(
      `SELECT t.id AS tokenId, t.device_id AS deviceId, t.status,
              t.install_key_id AS installKeyId
         FROM device_network n
         JOIN agent_tokens t ON t.device_id = n.device_id
        WHERE n.mac_address = ? AND t.status IN ${LIVE}
        ORDER BY t.id DESC
        LIMIT 1`,
      [mac],
    );
    if (byMac) return byMac;
  }
  if (hostname) {
    const [[byHost]] = await db.query(
      `SELECT t.id AS tokenId, t.device_id AS deviceId, t.status,
              t.install_key_id AS installKeyId
         FROM devices d
         JOIN agent_tokens t ON t.device_id = d.device_id
        WHERE d.device_name = ? AND d.device_type = 'server'
          AND t.status IN ${LIVE}
        ORDER BY t.id DESC
        LIMIT 1`,
      [hostname],
    );
    if (byHost) return byHost;
  }
  return null;
}

// First-run enrollment: creates the device rows in one transaction. A returning
// machine reuses its enrollment instead of creating a duplicate.
async function register(host, installKeyId = null) {
  // MAC can change between runs (Wi-Fi randomization, VPN adapters), so hostname is
  // the fallback.
  const existing = await findExistingEnrollment(host.mac_address || null, host.hostname || null);

  // Revoked machine coming back: re-arm the same row (new pending token, needs
  // approval again) so it keeps its id, logs and history.
  if (existing && existing.status === "revoked") {
    const pendingToken = crypto.randomBytes(24).toString("hex");
    await db.query(
      `UPDATE agent_tokens
          SET pending_token_hash = ?, approved_token_hash = NULL, approved_token_cipher = NULL,
              status = 'pending',
              install_key_id = ?, created_at = NOW(), last_used_at = NOW(), approved_at = NULL
        WHERE id = ?`,
      [hashKey(pendingToken), installKeyId, existing.tokenId],
    );
    await refreshHostInfo(existing.deviceId, host);
    return { pendingToken, deviceId: existing.deviceId, reused: true, reEnrolled: true };
  }

  if (existing) {
    // Returning machine: refresh host info, keep the approval state.
    await refreshHostInfo(existing.deviceId, host);

    // Move the server onto the key it just re-registered with, so revoking that key
    // covers it. Issue a fresh pending token each time: only its hash is stored, so the
    // old one can't be handed back.
    const pendingToken = crypto.randomBytes(24).toString("hex");
    await db.query(
      `UPDATE agent_tokens SET pending_token_hash = ?, install_key_id = COALESCE(?, install_key_id) WHERE id = ?`,
      [hashKey(pendingToken), installKeyId ?? null, existing.tokenId],
    );
    return { pendingToken, deviceId: existing.deviceId, reused: true };
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
      [deviceId, host.gateway || "", host.dns || "", networkSegment(host.ip_address), host.mac_address || null],
    );

    await conn.query(
      `INSERT INTO agent_tokens (device_id, install_key_id, pending_token_hash, status, last_used_at)
       VALUES (?, ?, ?, 'pending', NOW())`,
      [deviceId, installKeyId, hashKey(pendingToken)],
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

// Refresh specs + network info. Leaves the token and approval untouched.
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
  // Looked up by hash; no readable token is stored.
  const [[row]] = await db.query(
    `SELECT status, approved_token_cipher, device_id
       FROM agent_tokens WHERE pending_token_hash = ? LIMIT 1`,
    [hashKey(token)],
  );
  if (!row) return null;
  return {
    status: row.status,
    // A decrypt failure returns "" instead of a 500: the agent keeps polling and an
    // operator re-enrolls it.
    approved_token: readApprovedToken(row),
    device_id: row.device_id,
  };
}

/** The token in readable form, or "" when it cannot be produced. */
function readApprovedToken(row) {
  if (!row.approved_token_cipher) return ""; // approved before the cipher column existed
  try {
    return secretCrypto.decrypt(row.approved_token_cipher) || "";
  } catch (err) {
    console.error(
      `[agent-tokens] cannot decrypt approved_token_cipher for device ${row.device_id} — ` +
        `${describeError(err)}. The encryption key changed since it was stored, so that ` +
        "server must be re-enrolled (it keeps its id, logs and history). Already-running " +
        "agents are UNAFFECTED — they hold their own token and lookup is by hash.",
    );
    return "";
  }
}

// ─── Admin approval ───────────────────────────────────────────────────────────

async function listPending() {
  const [rows] = await db.query(
    `SELECT d.device_id AS id, COALESCE(NULLIF(d.display_name, ''), d.device_name) AS name, d.ip_address AS ip, d.location,
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

  // Store a hash for lookup and an encrypted copy so the token can be delivered again
  // (e.g. a machine that lost agent.conf). Refuse to approve without an encryption key
  // rather than store it readable.
  if (!secretCrypto.isConfigured()) {
    throw unavailable(
      "Cannot approve: no encryption key is configured. Set SECRET_ENC_KEY (or " +
        "MIKROTIK_ENC_KEY) in backend/.env to 64 hex characters and restart the backend.",
    );
  }
  const [result] = await db.query(
    `UPDATE agent_tokens
        SET approved_token_hash = ?, approved_token_cipher = ?,
            status = 'approved', approved_at = NOW()
      WHERE device_id = ? AND status = 'pending'`,
    [hashKey(approvedToken), secretCrypto.encrypt(approvedToken), deviceId],
  );
  if (result.affectedRows === 0) return null;

  // Stay 'offline' until the first metric POST, which flips it online and raises
  // "Server online".
  await db.query(`UPDATE devices SET status = 'offline' WHERE device_id = ?`, [deviceId]);
  const [[dev]] = await db.query(`SELECT device_name FROM devices WHERE device_id = ?`, [deviceId]);
  return { approvedToken, deviceName: dev?.device_name };
}

// Reject a pending enrollment by deleting the device (related rows cascade).
// Never touches an approved server.
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
  // Lookup by hash. Needs migrations/2026-08-25_agent_token_hash.sql applied.
  const [[row]] = await db.query(
    `SELECT t.device_id, d.device_name, d.display_name, d.ip_address, d.location, s.os
       FROM agent_tokens t
       JOIN devices d ON d.device_id = t.device_id
       LEFT JOIN server_specs s ON s.device_id = t.device_id
      WHERE t.approved_token_hash = ? AND t.status = 'approved'
      LIMIT 1`,
    [hashKey(token)],
  );
  if (!row) return null;

  // Best-effort; a failed counter must not fail the request.
  db.query(`UPDATE agent_tokens SET last_used_at = NOW() WHERE approved_token_hash = ?`, [
    hashKey(token),
  ]).catch(() => {});
  return row;
}

// Called on each metric POST: mark the server online and refresh last_seen/uptime.
// Returns { cameOnline, maintenance } so the caller can log an offline→online
// transition and skip alerting during a planned maintenance window.
async function recordHeartbeat(deviceId, uptimeLabel, intervalSec = null) {
  const [[row]] = await db.query(`SELECT status FROM devices WHERE device_id = ? LIMIT 1`, [deviceId]);
  const maintenance = row?.status === "maintenance";
  // Just sent a shutdown notice: late posts must not flip it back Online.
  const held = isHeld(Number(deviceId));
  // In maintenance the status is operator-owned; a heartbeat must not change it.
  const cameOnline = Boolean(row) && !maintenance && !held && row.status !== "online";

  if (!maintenance && !held) {
    await db.query(`UPDATE devices SET status = 'online', updated_at = NOW() WHERE device_id = ?`, [
      deviceId,
    ]);
  }
  // last_seen updates even in maintenance. COALESCE keeps the stored interval when
  // an older agent doesn't report one.
  await db.query(
    `UPDATE server_specs
        SET last_seen = NOW(), uptime = ?, metric_interval_sec = COALESCE(?, metric_interval_sec)
      WHERE device_id = ?`,
    [uptimeLabel, intervalSec, deviceId],
  );

  // Back online: close the open offline alert.
  if (cameOnline) {
    await alertsService.autoResolveMetric(deviceId, "offline").catch((err) =>
      console.error("[agent] offline auto-resolve failed:", describeError(err)),
    );
  }
  return { cameOnline, maintenance, held };
}

// Park a server for planned downtime (no offline sweep, no alerts), or bring it
// back with its real status. Returns null when there is no such server.
async function setMaintenance(deviceId, enabled) {
  const id = Number(deviceId);
  const [[row]] = await db.query(
    `SELECT d.device_name AS name, s.last_seen AS lastSeen,
            s.metric_interval_sec AS metricIntervalSec
       FROM devices d
       LEFT JOIN server_specs s ON s.device_id = d.device_id
      WHERE d.device_id = ? AND d.device_type = 'server'
      LIMIT 1`,
    [id],
  );
  if (!row) return null;

  const status = enabled
    ? "maintenance"
    : isStale(row.lastSeen, row.metricIntervalSec)
      ? "offline"
      : "online";
  await db.query(`UPDATE devices SET status = ?, updated_at = NOW() WHERE device_id = ?`, [status, id]);

  // Reset bands so the first breach after the window alerts.
  alertBandState.resetDevice(id);
  // Alerts still open keep their band, so they can still auto-resolve afterwards.
  await alertsService.seedBands(id).catch((err) =>
    console.error("[agent] band re-seed failed:", describeError(err)),
  );
  if (!enabled) latestMetrics.delete(id); // stale numbers until the next real post

  // Close any open offline alert; the operator now owns this server's state.
  await alertsService.autoResolveMetric(id, "offline").catch((err) =>
    console.error("[agent] offline auto-resolve failed:", describeError(err)),
  );

  return { id, name: row.name, status: label(status) };
}

// logDevice lives in ./deviceLogs.js; re-exported below for existing callers.

// No matching rule = band "normal" (silent). See alertRulesService.js.
const SEV_RANK = alertRulesService.SEV_RANK;
const METRIC_LABEL = { cpu: "CPU", mem: "Memory", disk: "Disk" };

// Returns the device-log rows created this cycle (for live emit).
async function checkThresholds(deviceId, metrics) {
  const id = Number(deviceId);
  const events = [];

  // Disk uses the fullest volume, not just the root.
  const volumes = Array.isArray(metrics.volumes) ? metrics.volumes : [];
  const worstVolume = volumes.reduce(
    (worst, v) => (worst === null || v.percent > worst.percent ? v : worst),
    null,
  );

  for (const key of ["cpu", "mem", "disk"]) {
    let v = metrics[key];
    // Name the mount only when there is more than one volume.
    let where = "";
    if (key === "disk" && worstVolume) {
      v = worstVolume.percent;
      if (volumes.length > 1) where = ` (${worstVolume.mount})`;
    }
    if (typeof v !== "number" || Number.isNaN(v)) continue;
    const label = METRIC_LABEL[key];

    // Shared band state, so a resolve can re-arm it.
    const prevBand = alertBandState.getBand(id, key);
    const rules = await alertRulesService.getEffectiveRules(id, key);
    const { band, rule } = alertRulesService.nextBand(rules, v, prevBand);

    // Escalation is instant; a drop needs ALERT_RECOVERY_SAMPLES confirmations and
    // closes the alerts it made untrue.
    const { effective: effectiveBand, downgraded, dropped } =
      await alertsService.settleBand(id, key, prevBand, band);
    const pct = Math.round(v);

    // Log a confirmed drop too, so every problem gets a matching recovery entry.
    if (dropped && !downgraded) {
      events.push(await logDevice(id, dropped === "normal" ? "info" : dropped,
        dropped === "normal"
          ? `${label} recovered: ${pct}%${where}`
          : `${label} down to ${dropped}: ${pct}%${where}`));
      continue;
    }

    // Otherwise log + alert only the onset of a worse band.
    if (!downgraded && SEV_RANK[effectiveBand] <= SEV_RANK[prevBand]) continue;

    const word = band === "critical" ? "critical" : band === "warning" ? "high" : band;
    events.push(await logDevice(id, band, downgraded
      ? `${label} down to ${band}: ${pct}%${where}`
      : `${label} ${word}: ${pct}%${where}`));
    await notificationService.raiseAlert({
      deviceId: id, type: key, severity: band,
      title: `${label} ${word}`, message: `${label} ${word}: ${pct}%${where}`,
      metricValue: v, alertRuleId: rule?.alert_rule_id ?? null,
    });
  }

  return events.filter(Boolean);
}

// ─── Offline sweep ────────────────────────────────────────────────────────────

// Mark approved servers offline when last_seen has gone stale. Returns only the
// rows that just changed, so each outage is logged once.
async function sweepOffline() {
  const [stale] = await db.query(
    `SELECT d.device_id AS id, COALESCE(NULLIF(d.display_name, ''), d.device_name) AS name
       FROM devices d
       JOIN agent_tokens t        ON t.device_id = d.device_id AND t.status = 'approved'
       LEFT JOIN server_specs s   ON s.device_id = d.device_id
      WHERE d.device_type = 'server'
        AND d.status = 'online'
        AND (s.last_seen IS NULL
             OR s.last_seen < (NOW() - INTERVAL ${OFFLINE_SQL_WINDOW} SECOND))`,
  );
  if (stale.length === 0) return [];

  const ids = stale.map((r) => r.id);
  await db.query(
    `UPDATE devices SET status = 'offline', updated_at = NOW()
      WHERE device_id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );

  return flipOffline(stale, "Server went offline — no metrics received");
}

// Shared by the heartbeat sweep and the ICMP sweep so both produce the same offline.
async function flipOffline(rows, reason) {
  const out = [];
  for (const r of rows) {
    latestMetrics.delete(Number(r.id));
    alertBandState.resetDevice(r.id); // re-arm threshold logging for when it returns…
    // …but keep the bands of open alerts so they can still auto-resolve.
    await alertsService.seedBands(r.id).catch((err) =>
      console.error("[agent] band re-seed failed:", describeError(err)),
    );
    const log = await logDevice(r.id, "warning", reason);
    out.push({ id: Number(r.id), name: r.name, log, reason });
  }
  return out;
}

// Mark servers offline now; only rows still 'online' change, so a race logs once.
// requireMissedReport (ICMP sweep): also require a missed agent report, since many
// servers block ping but still post fine.
async function markOfflineByIds(ids, { reason, requireMissedReport = true } = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger);
  if (list.length === 0) return [];
  const marks = list.map(() => "?").join(",");
  const missed = requireMissedReport
    ? `AND (s.last_seen IS NULL
             OR s.last_seen < (NOW() - INTERVAL CEIL(COALESCE(s.metric_interval_sec, ${DEFAULT_INTERVAL_SEC}) * 1.5) SECOND))`
    : "";
  const [rows] = await db.query(
    `SELECT d.device_id AS id, COALESCE(NULLIF(d.display_name, ''), d.device_name) AS name
       FROM devices d
       JOIN agent_tokens t      ON t.device_id = d.device_id AND t.status = 'approved'
       LEFT JOIN server_specs s ON s.device_id = d.device_id
      WHERE d.device_type = 'server' AND d.status = 'online' AND d.device_id IN (${marks})
        ${missed}`,
    list,
  );
  const flipped = [];
  for (const r of rows) {
    const [res] = await db.query(
      `UPDATE devices SET status = 'offline', updated_at = NOW() WHERE status = 'online' AND device_id = ?`,
      [r.id],
    );
    if (res.affectedRows > 0) flipped.push(r);
  }
  return flipOffline(
    flipped,
    reason ?? "Server went offline — stopped answering ICMP and missed a report",
  );
}

// Push the status change and raise the offline alert. `alert` overrides the wording
// for a shutdown notice.
async function announceOffline(io, rows, alert = null) {
  for (const o of rows ?? []) {
    io?.emit("serverStatus", { id: o.id, status: "Offline" });
    if (o.log) io?.emit("deviceLog", o.log);
    await notificationService.raiseAlert({
      deviceId: o.id,
      type: "offline",
      title: alert?.title ?? "Server offline",
      // Put the server's name in the message.
      message: alert
        ? `${o.name || `Server ${o.id}`} ${alert.verb}`
        : o.reason && o.name
          ? o.reason.replace(/^Server/, o.name)
          : o.log?.message || `Server ${o.id} stopped reporting`,
      // Critical so it reaches email (the default NOTIFY_EMAIL_MIN_SEVERITY).
      severity: alert?.severity ?? "critical",
    });
  }
}

// ─── Heartbeat + shutdown notice ──────────────────────────────────────────────
// In memory: after a restart the next beat (≤2s) refills it.
const lastBeat = new Map(); // device_id -> ms of the last heartbeat
const shutdownAt = new Map(); // device_id -> ms of the last shutdown notice

function isHeld(id) {
  const at = shutdownAt.get(id);
  if (at === undefined) return false;
  if (inShutdownHold(at, Date.now())) return true;
  shutdownAt.delete(id);
  return false;
}

// POST /api/servers/heartbeat. Records liveness only; only a metric POST marks a
// server Online.
function noteHeartbeat(deviceId) {
  const id = Number(deviceId);
  if (isHeld(id)) return;
  lastBeat.set(id, Date.now());
}

// Every second: any heartbeating server silent past HEARTBEAT_TIMEOUT_SEC goes offline.
async function sweepHeartbeats() {
  const stale = staleBeats(lastBeat, Date.now());
  if (stale.length === 0) return [];
  for (const id of stale) lastBeat.delete(id); // one attempt per silence, not one per tick
  return markOfflineByIds(stale, {
    reason: `Server went offline — no heartbeat for ${HEARTBEAT_TIMEOUT_SEC}s`,
    requireMissedReport: false,
  });
}

// POST /api/servers/shutdown. Returns the rows that went offline (none if already
// offline or in maintenance).
async function recordShutdown(deviceId, rawReason) {
  const id = Number(deviceId);
  const reason = shutdownReason(rawReason);
  shutdownAt.set(id, Date.now());
  lastBeat.delete(id);
  const rows = await markOfflineByIds([id], {
    reason:
      reason === "shutdown"
        ? "Server is shutting down or restarting (notice from its agent)"
        : "Monitoring agent was stopped (notice from its agent)",
    requireMissedReport: false,
  });
  return { rows, alert: SHUTDOWN_REASONS[reason] };
}

// ─── Dashboard reads ──────────────────────────────────────────────────────────

// Only servers with an APPROVED token appear on the dashboard.
const SERVER_SELECT = `
  SELECT d.device_id AS id,
         COALESCE(NULLIF(d.display_name, ''), d.device_name) AS name,
         d.device_name AS hostname, d.display_name AS displayName,
         d.ip_address AS ip, d.status,
         d.location, s.os, s.kernel, s.cores, s.architecture AS arch,
         s.memory_total_mb AS memoryTotalMB, s.disk_total_gb AS diskTotalGB,
         s.agent_version AS agentVersion, s.uptime, s.last_seen AS lastSeen,
         s.metric_interval_sec AS metricIntervalSec,
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

// Delete a server; related rows cascade, which also revokes its token. InfluxDB
// history is kept. Returns false if no such server.
async function removeServer(id) {
  const [result] = await db.query(
    `DELETE FROM devices WHERE device_id = ? AND device_type = 'server'`,
    [id],
  );
  if (result.affectedRows > 0) {
    latestMetrics.delete(Number(id));
    lastBeat.delete(Number(id));
    shutdownAt.delete(Number(id));
    alertBandState.resetDevice(id);
  }
  return result.affectedRows > 0;
}

// Set or clear (blank) a server's display name; the hostname is never changed.
// Returns { name, hostname, displayName }, or null if there is no such server.
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
  refreshHostInfo,
  getStatusByPendingToken,
  listPending,
  approve,
  reject,
  validateToken,
  recordHeartbeat,
  setMaintenance,
  cacheLatest,
  logDevice,
  getDeviceLogs,
  checkThresholds,
  sweepOffline,
  markOfflineByIds,
  announceOffline,
  noteHeartbeat,
  sweepHeartbeats,
  recordShutdown,
  getServers,
  getServerById,
  removeServer,
  renameServer,
};

export default agentService;
