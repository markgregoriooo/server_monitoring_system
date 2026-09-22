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
} from "./serverMetricUtils.js";
// Was a byte-identical private copy here. snmpUtils is pure and import-free, so
// taking it from there costs nothing and keeps device_network.network_segment
// written the same way whether the row came from an agent or the SNMP poller —
// which is what the comment on the other copy already claimed was true.
import { networkSegment } from "./snmpUtils.js";
import { logDevice, getDeviceLogs } from "./deviceLogs.js";
// The SAME hash the install keys use. Deliberately imported rather than re-implemented:
// two hashing schemes for two credential tables in one codebase is how one of them ends
// up wrong. See migrations/2026-08-25_agent_token_hash.sql for why SHA-256 and not bcrypt.
import { hashKey } from "./installKeyUtils.js";
// AES-256-GCM, keyed by SECRET_ENC_KEY (falling back to MIKROTIK_ENC_KEY). Used ONLY for
// the copy that has to be readable again — see approve()/getStatusByPendingToken below.
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

// A server counts as offline when no metric POST has refreshed its last_seen
// within its own window — three missed posts at that agent's reported cadence,
// floored by SERVER_OFFLINE_AFTER_SEC (default 30s). Sizing this per device is
// what stops an agent installed with `-interval 60` from flapping forever.
// See services/serverMetricUtils.js.
const OFFLINE_SQL_WINDOW = `GREATEST(${OFFLINE_FLOOR_SEC}, COALESCE(s.metric_interval_sec, ${DEFAULT_INTERVAL_SEC}) * 3)`;

// In-memory cache of each server's latest live metrics (cpu/mem/disk %, uptime),
// so GET /api/servers can render real numbers immediately after a browser refresh
// instead of waiting up to one agent interval (10s) for the next socket push.
// Resets on backend restart, then repopulates on the next metric POST.
const latestMetrics = new Map(); // device_id (number) -> { cpu, memory, diskUsed, uptime, volumes }

function cacheLatest(deviceId, live) {
  latestMetrics.set(Number(deviceId), live);
}

// True when a server's last heartbeat is older than ITS offline window (or never).
// intervalSec is that agent's reported cadence; null/unknown falls back to the
// default, which reproduces the old flat 30s.
function isStale(lastSeen, intervalSec) {
  if (!lastSeen) return true;
  return Date.now() - new Date(lastSeen).getTime() > offlineWindowSec(intervalSec) * 1000;
}

// Overlay cached live metrics + label the status for a server DB row. A server
// whose last_seen has gone stale reads as Offline with zeroed live metrics even
// if devices.status still says 'online' (the sweep may not have run yet) — so a
// GET right after a backend restart is already correct, not falsely Online.
//
// Maintenance is operator-owned and outranks staleness: a server parked for a
// planned reboot must NOT flip to Offline just because it stopped posting —
// that's the whole point of the window.
function withLive(r) {
  const maintenance = r.status === "maintenance";
  const offline = !maintenance && (r.status === "offline" || isStale(r.lastSeen, r.metricIntervalSec));
  const live = offline ? undefined : latestMetrics.get(r.id);
  // A server that has NEVER posted a metric is not the same thing as one that went
  // down, and until this flag existed both rendered as a bare "Offline". They need
  // opposite actions: an Offline server means go and look at a machine that was
  // working, while this means the agent has not reached the backend even once — wrong
  // -server URL, a firewall, or a service that was installed and never started. The
  // approval itself deliberately leaves the row 'offline' (see approve()), so there is
  // no status to read it off; `last_seen` is NULL until the first POST and is the only
  // durable evidence that the machine has ever spoken to us.
  const awaitingFirstReport = !maintenance && r.lastSeen == null;
  return {
    ...r,
    awaitingFirstReport,
    status: maintenance ? "Maintenance" : offline ? "Offline" : label(r.status),
    cpu: live?.cpu ?? 0,
    memory: live?.memory ?? 0,
    diskUsed: live?.diskUsed ?? 0,
    processCount: live?.processCount ?? null,
    // Every fixed volume from the last sample. Empty until the next metric post
    // after a backend restart (same lifetime as the other cached live values).
    volumes: live?.volumes ?? [],
    // A down server has no current uptime — don't surface the last-known value,
    // it reads as if the box were still up. Live rows use the cached label.
    uptime: offline ? null : (live?.uptime ?? r.uptime ?? null),
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

// Find a prior enrollment for a RETURNING machine. MAC first (most specific, when the
// NIC is stable), else hostname. The hostname match is scoped to server devices with a
// token row so it can't collide with manually-added devices.
//
// 'revoked' is included alongside pending/approved: a machine whose install key was
// revoked must be able to come back onto the SAME device_id when it re-enrols with a
// new key. Excluding it would spawn a duplicate device and fork the server's InfluxDB
// history, which is tagged by device_id. ('rejected' is NOT included — agentService.
// reject deletes the device outright, so no such row survives to match.)
//
// Returns { deviceId, status, tokenId, installKeyId } or null.
// Deliberately does NOT return a pending token: it is stored only as a hash now, and
// register() mints a fresh one for every caller anyway. See
// migrations/2026-08-25b_agent_pending_token_hash.sql.
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

// First-run enrollment. Creates devices + server_specs + device_network +
// agent_tokens rows in one transaction. Idempotent per MACHINE: a host that
// re-registers reuses its existing enrollment (so an agent restart — or a NIC/MAC
// change — before approval does not spawn duplicate pending devices).
async function register(host, installKeyId = null) {
  // Recognize a returning machine so it REUSES its enrollment instead of spawning a
  // duplicate device. Match by MAC first, then fall back to hostname: the agent's
  // "primary NIC" — and thus its MAC — can change between runs (Wi-Fi randomized MAC, a
  // different up interface, VPN/WSL/Hyper-V adapters), which would otherwise fragment one
  // server into many ghost device rows. Hostname is the stable identity the agent always
  // reports. refreshHostInfo() re-stamps the current MAC, so the next run matches on MAC.
  const existing = await findExistingEnrollment(host.mac_address || null, host.hostname || null);

  // A machine coming back after its install key was revoked. Re-arm the SAME token row
  // — new pending token, new owning key, approval required again — so the device keeps
  // its id, its logs and its InfluxDB history instead of forking into a second server.
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
    // Re-registering machine: refresh specs + network info (IP/gateway/DNS/MAC may have
    // changed) without disturbing the token or approval state.
    await refreshHostInfo(existing.deviceId, host);

    // ADOPT: re-attribute the enrollment to whichever key just re-registered it. This is
    // the only way an already-approved server can be moved onto a managed key — and
    // without it, every host enrolled before install keys existed (install_key_id NULL,
    // i.e. via the legacy .env key) would be permanently unreachable by any key revoke,
    // since register() short-circuits here and never touches the row again.
    //
    // It is also how a server MOVES between keys — hand it to another branch's key by
    // re-running the installer with that key. Presenting a valid install key is already
    // the authority to enrol a machine, so it is the right authority to re-file one; and
    // this grants no data access on its own, because metrics still need the AGT- token.
    // A FRESH pending token every time, rather than handing back the stored one.
    //
    // This is what makes hashing the column possible at all — you cannot return a hash.
    // Nothing depended on the token being stable: the agent holds it only in memory for
    // the duration of registration.Run and never writes it to agent.conf, so a returning
    // machine simply uses whichever token it was just given.
    //
    // Reaching this line already required presenting a valid AIK- install key, which is
    // the real authorisation to re-collect a credential. The pending token is just the
    // ticket for that one exchange.
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
  // Looked up by HASH — the column holds no readable token. One indexed comparison,
  // the same shape the plaintext compare had.
  const [[row]] = await db.query(
    `SELECT status, approved_token_cipher, device_id
       FROM agent_tokens WHERE pending_token_hash = ? LIMIT 1`,
    [hashKey(token)],
  );
  if (!row) return null;
  return {
    status: row.status,
    // THE re-delivery point — what a machine that lost its agent.conf comes back for, and
    // what the ADOPT workflow rides on. A decrypt failure is deliberately NOT fatal: it
    // means the encryption key changed since this token was stored, and the right answer
    // is an empty string (the agent keeps polling, an operator re-enrolls it) rather than
    // a 500 on an endpoint every pending agent hits every 10 seconds.
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

  // Two columns, two jobs — a hash cannot do both.
  //   approved_token_hash   the LOOKUP value, checked on every metric POST.
  //   approved_token_cipher a recoverable copy, because the token must be DELIVERABLE more
  //                         than once: the agent is asleep polling /api/agents/status when
  //                         this runs, and a machine that later loses agent.conf collects
  //                         it the same way (that path also carries the ADOPT workflow).
  //
  // Encryption is REQUIRED, not a fallback. There is deliberately no "store it readable if
  // no key is configured" branch: that branch is how the plaintext column existed in the
  // first place, and a silent downgrade to readable storage is exactly what this change is
  // undoing. Failing loudly at approval — one admin action, with a message naming the fix —
  // is far cheaper than a credential quietly landing in the nightly offsite dump.
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
  // Lookup is by HASH — one unique-indexed comparison, the same shape the plaintext
  // compare had, so the hottest query in the system (every agent, every 10 s) costs what
  // it always did. `migrations/2026-08-25_agent_token_hash.sql` must be applied before
  // this code runs; there is deliberately no plaintext fallback, because the column it
  // would fall back to no longer exists.
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

  // Best-effort, never awaited — a failed counter must not fail an ingest that already
  // authenticated.
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
  // A parked server keeps ingesting metrics, but its status is operator-owned:
  // a heartbeat must not drag it back to 'online', which would silently end the
  // window and re-arm alerting mid-reboot.
  const cameOnline = Boolean(row) && !maintenance && row.status !== "online";

  if (!maintenance) {
    await db.query(`UPDATE devices SET status = 'online', updated_at = NOW() WHERE device_id = ?`, [
      deviceId,
    ]);
  }
  // last_seen is refreshed even in maintenance, so leaving the window can tell a
  // live host from one that never came back. metric_interval_sec is only written
  // when the agent reported one — COALESCE keeps the stored value otherwise, so
  // an older agent never wipes a known cadence.
  await db.query(
    `UPDATE server_specs
        SET last_seen = NOW(), uptime = ?, metric_interval_sec = COALESCE(?, metric_interval_sec)
      WHERE device_id = ?`,
    [uptimeLabel, intervalSec, deviceId],
  );

  // Recovery: the agent is reporting again → close the open offline alert, the
  // same way deviceAlerts.checkReachability does for routers/UPS. Without this
  // every reboot left a permanently open alert inflating the sidebar badge.
  if (cameOnline) {
    await alertsService.autoResolveMetric(deviceId, "offline").catch((err) =>
      console.error("[agent] offline auto-resolve failed:", describeError(err)),
    );
  }
  return { cameOnline, maintenance };
}

// Park a server for planned downtime, or bring it back. While parked the offline
// sweep skips it, threshold alerting is suppressed, and a heartbeat won't flip
// the status — so a reboot doesn't page anyone. Leaving the window re-derives the
// real status from the last heartbeat rather than assuming Online.
// Returns null when there is no such server.
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

  // Re-arm the detectors on BOTH transitions so the first breach after the window
  // alerts, instead of being swallowed as "same band as before maintenance".
  alertBandState.resetDevice(id);
  if (!enabled) latestMetrics.delete(id); // stale numbers until the next real post

  // Close any open offline alert. An operator toggling this has explicitly taken
  // ownership of the server's state, and neither transition would otherwise clear
  // it: entering the window suppresses the heartbeat's cameOnline auto-resolve,
  // and a server that recovers WHILE parked never produces that transition at all.
  await alertsService.autoResolveMetric(id, "offline").catch((err) =>
    console.error("[agent] offline auto-resolve failed:", describeError(err)),
  );

  return { id, name: row.name, status: label(status) };
}

// Device logging moved to ./deviceLogs.js — it needs only the database, so the
// pollers and handlers that write log lines no longer pull in all of agentService.
// Re-exported below so existing agentService.logDevice(...) callers keep working.

// hysteresis so a value flapping at a boundary doesn't churn device_logs. With no
// matching rule the band is "normal" (rules-only → silent). See alertRulesService.js.
const SEV_RANK = alertRulesService.SEV_RANK;
const METRIC_LABEL = { cpu: "CPU", mem: "Memory", disk: "Disk" };

// Returns the device-log rows created this cycle (for live emit).
async function checkThresholds(deviceId, metrics) {
  const id = Number(deviceId);
  const events = [];

  // Disk is evaluated against the WORST volume, not just the root. A data volume
  // filling up while C:\ looks healthy is the common real incident and used to be
  // invisible here. The band is still tracked under the single "disk" metric (one
  // rule, one open alert per server) — the message names the offending mount.
  const volumes = Array.isArray(metrics.volumes) ? metrics.volumes : [];
  const worstVolume = volumes.reduce(
    (worst, v) => (worst === null || v.percent > worst.percent ? v : worst),
    null,
  );

  for (const key of ["cpu", "mem", "disk"]) {
    let v = metrics[key];
    // Name the mount only on multi-volume hosts — on a single-volume box
    // "Disk high: 91% (/)" is just noise.
    let where = "";
    if (key === "disk" && worstVolume) {
      v = worstVolume.percent;
      if (volumes.length > 1) where = ` (${worstVolume.mount})`;
    }
    if (typeof v !== "number" || Number.isNaN(v)) continue;
    const label = METRIC_LABEL[key];

    // Current band lives in the shared alertBandState so the lifecycle (resolve /
    // auto-resolve) can re-arm it — a still-breaching metric re-alerts after a resolve.
    const prevBand = alertBandState.getBand(id, key);
    const rules = await alertRulesService.getEffectiveRules(id, key);
    const { band, rule } = alertRulesService.nextBand(rules, v, prevBand);

    // Recovery needs CONFIRMATION — one normal sample can be a dip in a metric
    // oscillating around its threshold. Hold the previous band until N consecutive
    // normals (alertBandState.confirmRecovery), so a server flapping across 90% raises
    // ONE alert instead of an alert/auto-resolve storm. Escalation is unaffected.
    let effectiveBand = band;
    if (band === "normal" && prevBand !== "normal") {
      if (alertBandState.confirmRecovery(id, key)) {
        await alertsService.autoResolveMetric(id, key);
      } else {
        effectiveBand = prevBand; // not convinced yet — stay in the old band
      }
    } else if (band !== "normal") {
      alertBandState.breakRecovery(id, key); // breaching again → run of normals broken
    }
    alertBandState.setBand(id, key, effectiveBand); // always track state (so a later breach re-arms)…

    // …but only LOG + alert the ONSET of a worse band — not steady-state or
    // recoveries — to keep device_logs lean and the bell quiet.
    if (SEV_RANK[effectiveBand] <= SEV_RANK[prevBand]) continue;

    const pct = Math.round(v);
    const word = band === "critical" ? "critical" : band === "warning" ? "high" : band;
    events.push(await logDevice(id, band, `${label} ${word}: ${pct}%${where}`));
    await notificationService.raiseAlert({
      deviceId: id, type: key, severity: band,
      title: `${label} ${word}`, message: `${label} ${word}: ${pct}%${where}`,
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

// The transition itself, shared by the heartbeat sweep above and the fast ICMP sweep
// (services/reachabilitySweep.js). Both must produce the SAME offline — same cache
// eviction, same band reset, same device log — or an outage caught in 5 seconds would
// read differently from the identical outage caught in 45.
async function flipOffline(rows, reason) {
  const out = [];
  for (const r of rows) {
    latestMetrics.delete(Number(r.id));
    alertBandState.resetDevice(r.id); // re-arm threshold logging for when it returns
    const log = await logDevice(r.id, "warning", reason);
    out.push({ id: Number(r.id), name: r.name, log });
  }
  return out;
}

// Mark specific servers offline NOW, for a caller that already has proof they are gone
// (the host stopped answering ICMP) rather than an inference from silence. Re-checks
// `status = 'online'` in the UPDATE's own WHERE so two sweeps racing on the same server
// cannot both claim the transition and log it twice.
async function markOfflineByIds(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger);
  if (list.length === 0) return [];
  const marks = list.map(() => "?").join(",");
  const [rows] = await db.query(
    `SELECT d.device_id AS id, d.device_name AS name
       FROM devices d
       JOIN agent_tokens t ON t.device_id = d.device_id AND t.status = 'approved'
      WHERE d.device_type = 'server' AND d.status = 'online' AND d.device_id IN (${marks})`,
    list,
  );
  if (rows.length === 0) return [];
  const ok = rows.map((r) => r.id);
  await db.query(
    `UPDATE devices SET status = 'offline', updated_at = NOW()
      WHERE status = 'online' AND device_id IN (${ok.map(() => "?").join(",")})`,
    ok,
  );
  return flipOffline(rows, "Server went offline — host stopped answering ICMP");
}

// Tell everyone. Split out of src/server.js so the fast sweep raises the identical
// alert rather than a second, subtly different one.
async function announceOffline(io, rows) {
  for (const o of rows ?? []) {
    io?.emit("serverStatus", { id: o.id, status: "Offline" });
    if (o.log) io?.emit("deviceLog", o.log);
    await notificationService.raiseAlert({
      deviceId: o.id,
      type: "offline",
      title: "Server offline",
      message: o.name
        ? `${o.name} went offline — no metrics received`
        : o.log?.message || `Server ${o.id} stopped reporting`,
      severity: "warning",
    });
  }
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
  getServers,
  getServerById,
  removeServer,
  renameServer,
};

export default agentService;
