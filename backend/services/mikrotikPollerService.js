import db from "../config/mysql.js";
import { loadInterfaceLabels } from "./interfaceLabels.js";
import mikrotikClient from "./mikrotikClient.js";
import { writeNetworkSample } from "./writeNetworkMetrics.js";
import icmpPing from "./icmpPing.js";
import { encrypt, decrypt } from "./mikrotikCrypto.js";
import deviceAlerts from "./deviceAlerts.js";
import alertBandState from "./alertBandState.js";
import { computeUtilizationPct, counterDelta } from "./snmpUtils.js";
import { logDevice } from "./deviceLogs.js";
import { describeError } from "../utils/httpError.js";

// ─── MikroTik poller (RouterOS API) ───────
// Counterpart of snmpPollerService, but over the RouterOS API. Produces the same
// sample shape and reuses writeNetworkSample() (router_metrics, network_traffic,
// the networkMetrics broadcast). Each building is a port, labelled through
// network_interfaces. Polling is the heartbeat, so there is no separate sweep.

const TIMEOUT_MS = Number(process.env.MIKROTIK_API_TIMEOUT_MS) || 5000;

// Hard ceiling on ONE device's poll inside pollAll. TIMEOUT_MS covers each API call,
// but a socket left half-open (the backend host changed networks mid-poll, a cable
// moved) can leave a call pending forever — and pollAll's `polling` guard then skips
// every later cycle, so the device reads Online with one stored sample and a chart
// that never fills. pollDeviceNow bypasses the guard, which is why "Add" still works.
const POLL_DEADLINE_MS = Math.max(TIMEOUT_MS * 6, 30_000);

function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ─── In-memory state (resets on restart, repopulates next cycle) ───────────────
const prevIface = new Map(); // `${id}:${name}` -> { rx(BigInt), tx(BigInt), t(ms) }
const latest = new Map(); // id -> shaped summary for GET /api/mikrotik

// ─── Devices deleted while a poll is running ────────────────────
// A poll can take the full MIKROTIK_API_TIMEOUT_MS, and a misconfigured device
// (the likeliest to be deleted) always does. Without this, the running poll would
// write a point for the deleted device and broadcast it, and the dashboard would
// add the row back. removeDevice records the id here for a few minutes, and the
// write/emit functions check it.
const removedAt = new Map(); // id -> ms timestamp of the DELETE
const TOMBSTONE_MS = 5 * 60 * 1000;
function markRemoved(id) {
  removedAt.set(Number(id), Date.now());
}
function isRemoved(id) {
  const t = removedAt.get(Number(id));
  if (t == null) return false;
  if (Date.now() - t > TOMBSTONE_MS) {
    removedAt.delete(Number(id));
    return false;
  }
  return true;
}

const STATUS_LABEL = { online: "Online", offline: "Offline", warning: "Warning", maintenance: "Maintenance" };
const labelStatus = (s) => STATUS_LABEL[s] ?? "Offline";

// Logged once per process: the poller runs every 30s and would otherwise fill the log.
let decryptFailureReported = false;
const safeDecrypt = (v) => {
  if (!v) return "";
  try {
    return decrypt(v);
  } catch (err) {
    if (!decryptFailureReported) {
      decryptFailureReported = true;
      console.error(
        `[MIKROTIK] Cannot decrypt a stored API password: ${err.message}
` +
          `[MIKROTIK] This almost always means MIKROTIK_ENC_KEY in backend/.env is not the key
` +
          `[MIKROTIK] the password was encrypted under. Logins will fail with an empty password
` +
          `[MIKROTIK] until the key is restored, or the credentials are re-entered in the dashboard.`,
      );
    }
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
// creating the mikrotik connection
const connFor = (d) => ({
  host: d.ip,
  port: d.apiPort || 8728,
  tls: Boolean(d.useTls),
  user: d.apiUser,
  password: safeDecrypt(d.apiPass),
  timeout: TIMEOUT_MS,
});

// ─── Utilization (per-interface delta vs the previous cycle) ───────────────────
// Uses the shared computeUtilizationPct: the busier direction divided by link
// speed, since Ethernet is full-duplex. Summing both directions read up to twice
// the SNMP poller's value for the same load.
function withUtilization(deviceId, ifaces) {
  const now = Date.now();
  return ifaces.map((i) => {
    const rx = i.rxBytes ?? 0n;
    const tx = i.txBytes ?? 0n;
    let utilizationPct = null;
    const key = `${deviceId}:${i.name}`;
    const prev = prevIface.get(key);
    if (prev) {
      utilizationPct = computeUtilizationPct({
        dRxBytes: counterDelta(rx, prev.rx), // discards a wrap/reboot
        dTxBytes: counterDelta(tx, prev.tx),
        dtSec: (now - prev.t) / 1000,
        speedMbps: i.speedMbps,
      });
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
// `reason` goes into the device_logs line to tell a router that is down from one
// that answers ping while its API rejects us (service disabled, wrong port,
// credentials, address-list rule). See pollDevice's catch.
async function setReachable(io, d, online, reason = "") {
  const id = Number(d.id);
  // Deleted while polling (see above): skip everything below so the device is not
  // brought back.
  if (isRemoved(id)) return;
  if (!online) latest.set(id, { status: "Offline", reachable: false, uptimeSeconds: null, interfaces: [] });
  const newStatus = online ? "online" : "offline";
  if (d.status === newStatus) return;
  try {
    await db.query(`UPDATE devices SET status = ?, updated_at = NOW() WHERE device_id = ?`, [newStatus, d.id]);
  } catch (err) {
    console.error("[MIKROTIK_POLLER] status update error:", describeError(err));
  }
  const log = await logDevice(
    d.id,
    online ? "info" : "warning",
    online ? "MikroTik reachable" : reason || "MikroTik unreachable — no API response",
  );
  if (log) io?.emit("deviceLog", log);
  io?.emit("networkStatus", { id: d.id, status: online ? "Online" : "Offline" });
  // Real alert (bell/email/Alerts page): raise on the offline transition, auto-resolve
  // on recovery. The campus MikroTik carries all building traffic → critical.
  await deviceAlerts.checkReachability(d, online, { label: "MikroTik", severity: "critical" });
}

// Router CPU/mem, link utilization and interface-down alerting are in
// deviceAlerts.js, shared with the SNMP poller.

// ─── Per-device poll ────────────────────────────────────────────────────────────
async function pollDevice(io, d) {
  const labels = await loadInterfaceLabels(d.id);
  // Ping at the same time as the API call, like the SNMP poller. Started first so the
  // two overlap; icmpPing never rejects. Gives the MikroTik latency_ms and
  // packet_loss_pct like every other router.
  const icmpPromise = icmpPing.ping(d.ip);

  let sample;
  try {
    sample = await collect(d, labels); // throws if unreachable
  } catch (err) {
    // Each `return` below is a failed poll that is handled here rather than rethrown
    // (pollAll's catch would reset the cache and lose the ICMP figures). Each path
    // returns its own result, so pollDeviceNow can report a wrong password correctly.
    const icmp = await icmpPromise;

    // node-routeros can reject a failed connect with an empty message, so fall back
    // through the fields that have something.
    const cause = err?.message || err?.code || err?.errno || String(err ?? "") || "no detail from the RouterOS client";

    // If ping itself could not run (no binary, no permission), reachable:false is not a
    // measurement. Report only what was seen and store nothing, as in pollRouterByPing.
    if (icmp.probeError) {
      console.error(
        `[MIKROTIK_POLLER] poll failed for ${d.name} (${d.ip}): ${cause} ` +
          `— and ICMP is unavailable (${icmp.probeError}), so a dead router cannot be told ` +
          `from a rejected API login.`,
      );
      await setReachable(io, d, false);
      return { reachable: false, reason: `${cause} — and ICMP is unavailable on the backend host (${icmp.probeError})` };
    }

    const verdict = icmp.reachable
      ? `MikroTik API not responding — but the host ANSWERS ICMP (${icmp.latencyMs} ms), ` +
        `so RouterOS is up and the API is the problem: service disabled, wrong port, ` +
        `credentials rejected, or an address-list rule`
      : "MikroTik unreachable — no API response and no ICMP reply either, so the device or its link is down";

    console.error(`[MIKROTIK_POLLER] poll failed for ${d.name} (${d.ip}): ${cause} — ${verdict}`);
    await setReachable(io, d, false, verdict);


    // The ICMP fields are still written, so the record shows "unreachable, yet answers
    // ping in 2.3 ms", which points straight at a dead API on a live router.
    const icmpOnly = {
      reachable: false,
      descr: null,
      sysName: null,
      uptimeSeconds: null,
      cpuPercent: null,
      memPercent: null,
      latencyMs: icmp.latencyMs,
      packetLossPct: icmp.packetLossPct,
      connectedClients: null,
      interfaces: [],
    };
    if (isRemoved(d.id)) return { reachable: false, reason: "device was removed mid-poll" };
    await writeNetworkSample(
      io,
      { id: d.id, name: d.name, ip: d.ip, type: d.type, location: d.location },
      icmpOnly,
    );
    await deviceAlerts.checkRouter(io, d, icmpOnly);

    // Overwrites the bare entry setReachable() just wrote, so the tiles and
    // GET /api/mikrotik keep showing the latency and loss that are still being measured.
    latest.set(Number(d.id), {
      status: "Offline",
      // Matches `status`, since NetworkDetail shows this flag under Status and
      // "Offline / reachable" would contradict itself. Ping results are shown elsewhere.
      reachable: false,
      latencyMs: icmp.latencyMs,
      packetLossPct: icmp.packetLossPct,
      uptimeSeconds: null,
      cpuPercent: null,
      memPercent: null,
      connectedClients: null,
      interfaces: [],
    });
    return { reachable: false, reason: `${cause} — ${verdict}` };
  }

  const icmp = await icmpPromise;
  sample.latencyMs = icmp.latencyMs;
  sample.packetLossPct = icmp.packetLossPct;
  if (isRemoved(d.id)) return { reachable: false, reason: "device was removed mid-poll" };
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
    // Cache the ICMP figures so GET /api/mikrotik can return them.
    latencyMs: sample.latencyMs,
    packetLossPct: sample.packetLossPct,
    uptimeSeconds: sample.uptimeSeconds,
    cpuPercent: sample.cpuPercent,
    memPercent: sample.memPercent,
    connectedClients: sample.connectedClients,
    interfaces: sample.interfaces.map((i) => ({
      name: i.name,
      locationLabel: i.locationLabel ?? "",
      linkUp: Boolean(i.linkUp),
      // Kept separate from linkUp so the port editor can say "disabled in RouterOS"
      // instead of "down". See services/linkAlertPolicy.js.
      adminUp: i.adminUp !== false,
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
    console.error("[MIKROTIK_POLLER] last_seen update error:", describeError(err));
  }

  return { reachable: true, reason: null };
}

// ─── Main loop ──────────────────────────────────────────────────────────────────
let polling = false;

/**
 * Poll one MikroTik right away; the 30s schedule is unchanged. Same as
 * snmpPollerService.pollDeviceNow. With a MikroTik, "no data yet" and "wrong
 * password" look the same until a login is tried.
 *
 * Never throws; the caller does not wait so the HTTP response is not held up.
 * Returns `{ ok, reason }`, which routes/mikrotik.js sends to the admin who added
 * the device.
 */
export async function pollDeviceNow(io, deviceId) {
  const id = Number(deviceId);
  try {
    const d = (await loadDevices()).find((x) => Number(x.id) === id);
    if (!d) return { ok: false, reason: "device not found" };
    try {
      // `pollDevice` also resolves when it fails, so check its result instead of
      // treating "did not throw" as success.
      const r = await pollDevice(io, d);
      if (r?.reachable) return { ok: true, reason: null };
      return { ok: false, reason: r?.reason ?? "the router did not answer" };
    } catch (err) {
      const reason = describeError(err);
      console.error(`[MIKROTIK_POLLER] first poll of ${d.name} (${d.ip}) failed:`, reason);
      await setReachable(io, d, false);
      return { ok: false, reason };
    }
  } catch (err) {
    const reason = describeError(err);
    console.error("[MIKROTIK_POLLER] immediate poll error:", reason);
    return { ok: false, reason };
  }
}

async function pollAll(io) {
  if (polling) return;
  polling = true;
  try {
    const devices = await loadDevices();
    for (const d of devices) {
      try {
        await withDeadline(pollDevice(io, d), POLL_DEADLINE_MS, "poll");
      } catch (err) {
        // Fallback only. API failures are handled inside pollDevice; what lands here is a
        // failure in our own side (label lookup, InfluxDB write, alert check), so the
        // reason is logged as is.
        console.error(
          `[MIKROTIK_POLLER] poll failed for ${d.name} (${d.ip}):`,
          err?.message ?? err,
        );
        await setReachable(io, d, false); // treat as offline, keep going
      }
    }
  } catch (err) {
    console.error("[MIKROTIK_POLLER] load error:", describeError(err));
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
      latencyMs: live?.latencyMs ?? null,
      packetLossPct: live?.packetLossPct ?? null,
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
// `override` carries credentials from the form, so a login can be tested before
// it is saved.
//   id = null            → ad-hoc test (the Add form; the device does not exist yet)
//   id + override        → stored device, test what is typed now
//   id + empty override  → stored device, test what is saved
// A blank `apiPassword` in an override means "use the stored one".
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

  // Names must be unique among MikroTiks, so one router is not registered twice
  // (double polling, double alerts). LOWER() is explicit instead of relying on the
  // collation.
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
// One row per labelled port. Optional: a port without a row shows its RouterOS name.

async function getInterfaces(deviceId) {
  const [rows] = await db.query(
    `SELECT interface_name AS name, location_label AS label, ever_up, monitor_link
       FROM network_interfaces
      WHERE device_id = ?
      ORDER BY interface_name`,
    [Number(deviceId)],
  );
  return rows.map((r) => ({
    name: r.name,
    label: r.label ?? "",
    // Both drive the port editor's "why is this port quiet?" line. everUp is
    // observed, never set by hand; monitored is the admin's own switch.
    everUp: Boolean(r.ever_up),
    monitored: r.monitor_link !== 0,
  }));
}

// Upsert one row per port (no UNIQUE index, so check first). A blank label only
// deletes the row when it holds nothing else; the row also carries `ever_up` and
// `monitor_link`, which must not be lost when a label is cleared.
async function saveInterfaces(deviceId, labels) {
  const id = Number(deviceId);
  if (!Number.isInteger(id)) return { ok: false, error: "Invalid device id." };
  if (!Array.isArray(labels)) return { ok: false, error: "labels must be an array." };

  let gateChanged = false;

  for (const entry of labels) {
    const name = String(entry?.name ?? "").trim();
    if (!name || name.length > 50) continue;
    const label = String(entry?.label ?? "").trim().slice(0, 100);
    // Omitted (older client, or a caller that only sends labels) = leave as-is.
    const monitored = entry?.monitored == null ? null : entry.monitored !== false;

    const [existing] = await db.query(
      `SELECT id, ever_up, monitor_link FROM network_interfaces
        WHERE device_id = ? AND interface_name = ? LIMIT 1`,
      [id, name],
    );

    if (existing.length) {
      const row = existing[0];
      const nextMonitored = monitored == null ? row.monitor_link !== 0 : monitored;
      if (nextMonitored !== (row.monitor_link !== 0)) gateChanged = true;

      // Nothing left to remember → drop the row, as before.
      if (!label && !row.ever_up && nextMonitored) {
        await db.query(`DELETE FROM network_interfaces WHERE id = ?`, [row.id]);
        continue;
      }
      await db.query(
        `UPDATE network_interfaces
            SET location_label = ?, monitor_link = ?, updated_at = NOW()
          WHERE id = ?`,
        [label, nextMonitored ? 1 : 0, row.id],
      );
      continue;
    }

    // No row yet: only create one if it would actually say something.
    if (!label && monitored !== false) continue;
    if (monitored === false) gateChanged = true;
    await db.query(
      `INSERT INTO network_interfaces (device_id, interface_name, location_label, is_active, ever_up, monitor_link)
       VALUES (?, ?, ?, 1, 0, ?)`,
      [id, name, label, monitored === false ? 0 : 1],
    );
  }

  // deviceAlerts caches monitor_link per device for the poll hot path, so a mute made
  // here would otherwise not take effect until the next backend restart.
  if (gateChanged) deviceAlerts.invalidateLinkGate(id);

  // Reflect the new labels in the cached view immediately — otherwise they wouldn't
  // appear until the next poll, up to MIKROTIK_POLL_INTERVAL_MS later.
  const cached = latest.get(id);
  if (cached?.interfaces?.length) {
    const map = await loadInterfaceLabels(id);
    cached.interfaces = cached.interfaces.map((i) => ({ ...i, locationLabel: map[i.name] ?? "" }));
  }
  return { ok: true };
}

// ─── Admin: remove a MikroTik ─────────────────────────────────────────────
// Deleting the devices row cascades to mikrotik_devices, network_interfaces,
// device_logs and alerts. Also clears this device's in-memory state so a reused
// id starts clean. InfluxDB history is kept. Same as snmpPollerService.removeDevice.
async function removeDevice(id) {
  const deviceId = Number(id);
  if (!Number.isInteger(deviceId)) return false;

  const [result] = await db.query(
    `DELETE FROM devices WHERE device_id = ? AND device_type = 'mikrotik'`,
    [deviceId],
  );
  if (result.affectedRows === 0) return false;

  markRemoved(deviceId); // a poll may already be in flight — see the tombstone note
  latest.delete(deviceId);
  for (const key of prevIface.keys()) {
    if (key.startsWith(`${deviceId}:`)) prevIface.delete(key);
  }
  alertBandState.resetDevice(deviceId); // severity bands
  deviceAlerts.resetDevice(deviceId); // link gate / uptime / error counters
  return true;
}

export default {
  pollAll,
  // See the note on snmpPollerService.setReachable — same reason.
  setReachable,
  pollDeviceNow,
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
