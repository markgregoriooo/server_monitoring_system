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

// ─── Tombstones: devices deleted while a poll was IN FLIGHT ────────────────────
//
// A poll takes up to MIKROTIK_API_TIMEOUT_MS (5s) — and takes the FULL timeout precisely
// when the device is misconfigured, which is the one most likely to be deleted. Delete it
// in that window and the in-flight poll still ran to completion: it wrote a
// router_metrics point for a device that no longer exists, and broadcast `networkMetrics`
// for it. The dashboard's merge treats an id it does not know as a NEW device and appends
// it — so the row the admin had just deleted reappeared, and stayed until a reload.
//
// `removeDevice` records the id here; the two functions that write or emit consult it.
// Time-bounded rather than permanent so the map cannot grow for the life of the process,
// and generously — one poll interval would be enough, several minutes costs nothing and
// also covers a device deleted during a slow retry.
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
//
// Uses the SHARED computeUtilizationPct rather than its own arithmetic. This function
// used to divide (dRx + dTx) by the link capacity — the sum of both directions — while
// the SNMP poller takes the busier DIRECTION. Ethernet is full-duplex, so each direction
// gets the full link speed: a 100 Mbit/s port carrying 60 Mbit/s each way is at 60%, not
// 120%. Both pollers feed the SAME global `link_util` rule, so the MikroTik was reporting
// up to twice an SNMP router's figure for identical load and tripping the 80% warning at
// around 40% real utilisation.
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
// `reason` names WHICH failure this is, for the device_logs line. Without it every
// failure read "MikroTik unreachable — no API response", which conflates two states
// needing opposite fixes: a router that is genuinely down, and a router that is up and
// answering ICMP while its API rejects us (service disabled, wrong port, credentials,
// an address-list rule). The SNMP poller has drawn exactly this distinction since it
// was written; this one never did. See pollDevice's catch.
async function setReachable(io, d, online, reason = "") {
  const id = Number(d.id);
  // Deleted mid-poll — see the tombstone note above. Everything below writes to the
  // device row, the device log, the alert state or the browsers, all of which would be
  // resurrecting a device an admin removed.
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

// Router CPU/mem + per-interface link utilization & interface-down alerting now
// lives in deviceAlerts.js (configurable alert_rules + REAL alerts: bell / email /
// Alerts page), shared with the generic SNMP poller — replacing the device-log-only
// interface-down check that used to be here.

// ─── Per-device poll ────────────────────────────────────────────────────────────
async function pollDevice(io, d) {
  const labels = await loadInterfaceLabels(d.id);
  // ICMP alongside the API call, exactly as the SNMP poller does it. Started first so
  // the two overlap rather than adding their latencies together; icmpPing never
  // rejects, so this is always safe to await.
  //
  // Without it a MikroTik was the one router class with no latency_ms / packet_loss_pct
  // at all — so `router_latency` and `router_loss` (alert rules, Analytics trends and
  // anomalies, the report columns) silently had no data for the campus core routers,
  // which are the devices those metrics matter most for. It also made the metric
  // inconsistent: present on some routers, absent on others, for no reason a user
  // could see.
  const icmpPromise = icmpPing.ping(d.ip);

  let sample;
  try {
    sample = await collect(d, labels); // throws if unreachable
  } catch (err) {
    // ⚠️ Every `return` below is a FAILED poll that this function deliberately does not
    // rethrow (pollAll's catch would reset the cache and wipe the ICMP figures). That
    // made "did not throw" mean nothing, and pollDeviceNow — which reports the result of
    // a registration back to the admin — read it as success. A MikroTik added with a
    // wrong password therefore answered with "logged in over the RouterOS API — now
    // polling". Each path now returns its own verdict, and the toast says what happened.
    //
    // Handled here rather than rethrown: pollAll's catch calls setReachable(), which
    // resets the `latest` cache entry, and that would wipe the ICMP figures again.
    const icmp = await icmpPromise;

    // node-routeros can reject a failed connect with an error carrying NO message at
    // all (verified against a closed port: `err.message` is ""), which left the log
    // line reading "poll failed for X (ip):  — …" with a blank where the cause belongs.
    // Fall back through the fields that do carry something.
    const cause = err?.message || err?.code || err?.errno || String(err ?? "") || "no detail from the RouterOS client";

    // A BROKEN PROBE IS NOT A MEASUREMENT. No `ping` binary, or an account that cannot
    // run it, yields reachable:false — the absence of an observation, not an outage.
    // Report only what was actually seen, and store nothing. Same guard, and the same
    // reasoning, as pollRouterByPing in the SNMP poller.
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


    // Nothing is lost by saying so. The ICMP fields below are still written, so the
    // stored record reads "unreachable, yet answering in 2.3 ms with no loss" — which
    // is precisely the signature of a live router with a dead API, and is a sharper
    // diagnostic than a bare reachable:true would have been.
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
      // Agrees with `status` for the same reason as above — NetworkDetail's Status tile
      // prints "reachable" as its subtitle from this flag, and "Offline / reachable" is
      // a contradiction on screen. That the host answers ping is carried by the two
      // ICMP figures, the device_logs line and the ICMP chart, none of which conflict
      // with anything.
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
    // ICMP, collected above. Cached so GET /api/mikrotik can serve it — without this
    // the poller measured latency, wrote it to InfluxDB and alerted on it, while the
    // pages that show a MikroTik had no way to read it at all.
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
      // Carried separately from linkUp so the port editor can say "disabled in
      // RouterOS" rather than "down" — the two look identical on the wire but only
      // one of them is a fault. See services/linkAlertPolicy.js.
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
 * Poll ONE MikroTik immediately, then leave the 30s cadence untouched.
 *
 * Same reasoning as snmpPollerService.pollDeviceNow — see the long note there. The wait is
 * shorter here (MIKROTIK_POLL_INTERVAL_MS, 30s) but the feedback matters more: a MikroTik is
 * registered with a USERNAME AND PASSWORD, so "no data yet" and "those credentials are
 * wrong" look identical until something actually tries to log in.
 *
 * Never throws — the caller fires and forgets so the HTTP response is not held behind an API
 * timeout.
 *
 * Returns `{ ok, reason }` rather than a bare boolean so the caller can TELL SOMEBODY: a
 * failed first login used to reach the server console and nowhere else. routes/mikrotik.js
 * forwards it to the admin who registered the device. Same contract as
 * snmpPollerService.pollDeviceNow.
 */
export async function pollDeviceNow(io, deviceId) {
  const id = Number(deviceId);
  try {
    const d = (await loadDevices()).find((x) => Number(x.id) === id);
    if (!d) return { ok: false, reason: "device not found" };
    try {
      // ⚠️ `pollDevice` resolves on the failure path too — see the note in its catch.
      // Reading "it did not throw" as success is what made a MikroTik added with a wrong
      // password toast "logged in over the RouterOS API — now polling".
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
        await pollDevice(io, d);
      } catch (err) {
        // Now a BACKSTOP only. The API-unreachable case — by far the common one — is
        // handled inside pollDevice, which combines it with the ICMP verdict and does
        // not rethrow. What still lands here is everything else: a label lookup, an
        // InfluxDB write, an alert evaluation. Those are faults in the monitoring
        // rather than in the router, so the reason is logged verbatim.
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

// Upsert one row per port. There is no UNIQUE index on (device_id, interface_name),
// so this checks before writing rather than relying on ON DUPLICATE KEY.
//
// A blank label used to DELETE the row, on the principle that "no label" is the absence
// of a row. That stopped being safe once the row also carries alerting state: clearing
// a label would have thrown away `ever_up` (making a live port look never-connected and
// silencing it) and `monitor_link` (un-silencing a port an admin had muted). So a row is
// only deleted when it holds nothing else worth keeping — otherwise the label is blanked
// in place and the table still doesn't accumulate rows that say nothing.
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
