import db from "../config/mysql.js";
import { loadInterfaceLabels } from "./interfaceLabels.js";
import client, {
  SYS_OID,
  IF_OID,
  IF_OPER_STATUS,
  IF_ADMIN_STATUS,
  UPS_OID,
  isOnBattery,
  isOnBypass,
  upsOutputState,
} from "./snmpClient.js";
import icmpPing from "./icmpPing.js";
import deviceAlerts from "./deviceAlerts.js";
import alertBandState from "./alertBandState.js";
import { writeNetworkSample } from "./writeNetworkMetrics.js";
import { writeUpsSample } from "./writeUpsMetrics.js";
import { logDevice } from "./deviceLogs.js";
import {
  badRequest,
  inRange,
  UPS_BOUNDS,
  normalizePort,
  isValidIp,
  networkSegment,
  computeUtilizationPct,
  counterDelta,
} from "./snmpUtils.js";
import { describeError } from "../utils/httpError.js";
import { writeCommunity, readCommunity } from "./communityCrypto.js";

// ─── SNMP poller: routers (IF-MIB) + UPS (UPS-MIB) ─────────────────
// Instead of agents pushing metrics, this polls each device over SNMP on a timer
// (server.js calls pollAll() on an interval). Polling is the heartbeat, so each cycle
// sets devices.status directly.
//
// Two modes for a router, depending on whether it has a community (see loadDevices):
//
//   SNMP  full read: interfaces, traffic counters, link state, uptime. Ping runs
//         alongside for latency and packet loss, which SNMP cannot show.
//   PING  ICMP only: reachable, latency, loss. For ISP-owned equipment that does
//         not answer SNMP.
//
// A UPS always uses SNMP; a ping only proves the management card has power.

const SNMP_TIMEOUT_MS = 5000;
const SNMP_RETRIES = 1;

// ─── In-memory state (resets on restart, repopulates on the next cycle) ─────────

// Previous per-interface byte counters, for utilization_pct (rate ÷ link speed).
// key `${deviceId}:${ifIndex}` -> { rxBytes(BigInt), txBytes(BigInt), t(ms) }
const prevIface = new Map();
// Latest values per device, so GET /api/network and GET /api/ups show numbers right
// away (like agentService.latestMetrics). Refilled on the next poll after a restart.
const latestNetwork = new Map(); // id -> shaped router summary
const latestUps = new Map(); // id -> shaped UPS summary

// ─── Devices deleted while a poll is running ────────────────────
// An SNMP walk can take SNMP_TIMEOUT_MS x (SNMP_RETRIES + 1), and a misconfigured
// device (the likeliest to be deleted) always takes that long. Without this, the
// running poll would write a point for the deleted device and broadcast it, and the
// dashboard would add the row back. removeDevice records the id for a few minutes;
// setReachable and the sample writes check it. Same as mikrotikPollerService.
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const firstValue = (m) => {
  const k = Object.keys(m)[0];
  return k === undefined ? null : m[k];
};
// SNMP session settings for a device. No default community: guessing "public" for a
// missing one would quietly probe a real device with a guessed credential. Throw
// instead so an upstream bug shows up.
const connFor = (d) => {
  const community = typeof d.community === "string" ? d.community.trim() : "";
  if (!community) {
    throw new Error(
      `SNMP poll attempted for "${d.name ?? d.ip}" (id ${d.id}) with no community string. ` +
        "A router without one is monitored by ICMP (pollRouterByPing) and a UPS without " +
        "one is not loaded at all, so reaching here means loadDevices/pollRouter changed.",
    );
  }
  return {
    host: d.ip,
    community,
    port: d.snmpPort || 161,
    timeout: SNMP_TIMEOUT_MS,
    retries: SNMP_RETRIES,
  };
};

// ─── Collectors (pure SNMP → sample; no DB, no Influx — unit-testable) ──────────

// Poll one router and return a network sample, with utilization_pct from the change
// since the last cycle. Throws when unreachable; the caller marks it offline.
export async function collectRouter(deviceId, conn, labels = {}) {
  const session = client.openSession(conn);
  try {
    const sys = await client.get(session, [SYS_OID.sysDescr, SYS_OID.sysUpTime, SYS_OID.sysName]);

    // Walk the IF-MIB columns we need (sequential — one UDP session).
    const names = await client.walkColumn(session, IF_OID.ifName);
    const oper = await client.walkColumn(session, IF_OID.ifOperStatus);
    // ifAdminStatus is what the operator configured, so a port shut down on purpose is
    // not reported like an unplugged one. Optional: a missing value counts as enabled.
    const admin = await client.walkColumn(session, IF_OID.ifAdminStatus).catch(() => ({}));
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
      const adminUp = admin[idx] == null || Number(admin[idx]) !== IF_ADMIN_STATUS.down;
      const speedMbps = Number(speed[idx] ?? 0);

      // utilization_pct from the change since the last cycle, using the busier direction
      // (full-duplex), not rx + tx. See snmpUtils.computeUtilizationPct.
      let utilizationPct = null;
      const key = `${deviceId}:${idx}`;
      const prev = prevIface.get(key);
      if (prev) {
        utilizationPct = computeUtilizationPct({
          dRxBytes: counterDelta(rxBytes, prev.rxBytes),
          dTxBytes: counterDelta(txBytes, prev.txBytes),
          dtSec: (now - prev.t) / 1000,
          speedMbps,
        });
      }
      prevIface.set(key, { rxBytes, txBytes, t: now });

      interfaces.push({
        name,
        locationLabel: labels[name] ?? "",
        rxBytes,
        txBytes,
        rxErrors: Number(inErr[idx] ?? 0),
        txErrors: Number(outErr[idx] ?? 0),
        // ifHighSpeed (Mbit/s), shown in the UI: a 1 Gb port running at 10 Mb is a
        // cable/duplex problem that utilization alone hides. 0 = unknown, sent as null.
        speedMbps: speedMbps > 0 ? speedMbps : null,
        linkUp,
        adminUp,
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

    // Every reading is checked against UPS_BOUNDS; out of range is a firmware
    // placeholder, not a measurement, and becomes null. See snmpUtils.inRange.
    const B = UPS_BOUNDS;
    const battV = inRange(s[UPS_OID.upsBatteryVoltage], ...B.batteryVoltageDeci);
    const src = s[UPS_OID.upsOutputSource];
    return {
      reachable: true,
      batteryChargePct: inRange(s[UPS_OID.upsEstimatedChargeRemaining], ...B.batteryChargePct),
      runtimeRemainingMin: inRange(s[UPS_OID.upsEstimatedMinutesRemaining], ...B.runtimeRemainingMin),
      loadPct: inRange(firstValue(load), ...B.loadPct),
      inputVoltage: inRange(firstValue(inV), ...B.voltage),
      outputVoltage: inRange(firstValue(outV), ...B.voltage),
      batteryVoltage: battV == null ? null : battV / 10, // RFC 1628: 0.1 V DC units
      onBattery: src == null ? null : isOnBattery(src),
      // Where the load is powered from. `onBattery` alone cannot show bypass. See
      // snmpUtils.upsOutputState.
      onBypass: src == null ? null : isOnBypass(src),
      outputState: src == null ? null : upsOutputState(src),
      batteryStatus: inRange(s[UPS_OID.upsBatteryStatus], ...B.batteryStatus),
      temperature: inRange(s[UPS_OID.upsBatteryTemperature], ...B.temperatureC),
    };
  } finally {
    client.closeSession(session);
  }
}

// ─── DB reads ──────────────────────────────────────────────────────────────────

// Load the routers and UPS units to poll, and tag each with its mode.
//
// A router only needs an IP: with a community it is polled over SNMP, without one by
// ping (`pingOnly`), which is how ISP-owned equipment is monitored.
//
// A UPS needs an IP, a community and communication_type snmp/network.
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
  return rows
    .map((r) => ({ ...r, community: readCommunity(r.community) }))
    .filter((r) => {
      if (!r.ip) return false;
      if (r.type === "ups") return Boolean(r.community) && ["snmp", "network"].includes(r.commType);
      return true; // router: community → SNMP, none → ICMP
    })
    .map((r) => ({ ...r, pingOnly: r.type === "router" && !r.community }));
}

// Record the interfaces this poll found, so the admin has a list of ports to label
// and is_active stays current. location_label is kept on conflict (it is typed by a
// person). Needs the UNIQUE(device_id, interface_name) key from
// v13_cspc-ictu-monitoring-system.sql; without it, this is skipped with a warning
// instead of adding a row per interface per cycle.
let ifaceUpsertBroken = false;
async function syncInterfaces(deviceId, interfaces) {
  if (ifaceUpsertBroken || !interfaces?.length) return;
  const names = interfaces.map((i) => i.name).filter(Boolean);
  if (!names.length) return;
  try {
    await db.query(
      `INSERT INTO network_interfaces (device_id, interface_name, location_label, is_active)
       VALUES ${names.map(() => "(?, ?, '', 1)").join(", ")}
       ON DUPLICATE KEY UPDATE is_active = 1`,
      names.flatMap((n) => [deviceId, n]),
    );
    // Ports the device no longer reports stay as rows (their label is worth keeping)
    // but are flagged inactive so the UI can grey them out.
    await db.query(
      `UPDATE network_interfaces SET is_active = 0
        WHERE device_id = ? AND interface_name NOT IN (${names.map(() => "?").join(", ")})`,
      [deviceId, ...names],
    );
  } catch (err) {
    ifaceUpsertBroken = true;
    console.error(
      "[SNMP_POLLER] interface sync disabled — is the UNIQUE(device_id, interface_name) key on "
      + "network_interfaces present? It ships in v13_cspc-ictu-monitoring-system.sql.",
      err.message,
    );
  }
}

// Set the label for one discovered interface. Returns false when that device/port
// was never discovered (the caller returns 404).
async function setInterfaceLabel(deviceId, interfaceName, label) {
  const id = Number(deviceId);
  if (!Number.isInteger(id)) throw badRequest("Invalid device id.");
  const name = String(interfaceName ?? "").trim();
  if (!name) throw badRequest("Interface name is required.");
  const text = String(label ?? "").trim().slice(0, 100); // column is varchar(100)
  const [res] = await db.query(
    `UPDATE network_interfaces SET location_label = ?, updated_at = NOW()
      WHERE device_id = ? AND interface_name = ?`,
    [text, id, name],
  );
  if (res.affectedRows === 0) return null;
  // Push the new label straight into the live cache so the next GET/broadcast carries
  // it without waiting a full poll cycle.
  const live = latestNetwork.get(id);
  if (live?.interfaces) {
    for (const i of live.interfaces) if (i.name === name) i.locationLabel = text;
  }
  return { interfaceName: name, locationLabel: text };
}

// ─── Status + threshold logging ────────────────────────────────────────────────

const typeLabel = (d) => (d.type === "ups" ? "UPS" : "Router");

// Flip devices.status only on a real change, log the transition once, and emit a
// status event so the page updates live. Reachability comes straight from the poll.
async function setReachable(io, d, online) {
  const id = Number(d.id);
  // Deleted while polling (see above): skip everything below so the device is not
  // brought back.
  if (isRemoved(id)) return;
  // Update the live cache with the reachability, keeping the last readings (including
  // interfaces) so an offline router still shows what was connected.
  if (!online) {
    if (d.type === "ups") {
      latestUps.set(id, { ...(latestUps.get(id) ?? {}), status: "Offline" });
    } else {
      latestNetwork.set(id, {
        uptimeSeconds: null,
        interfaces: [],
        ...(latestNetwork.get(id) ?? {}),
        status: "Offline",
        reachable: false,
      });
    }
  }
  const newStatus = online ? "online" : "offline";
  if (d.status === newStatus) return;
  try {
    await db.query(`UPDATE devices SET status = ?, updated_at = NOW() WHERE device_id = ?`, [newStatus, d.id]);
  } catch (err) {
    console.error("[SNMP_POLLER] status update error:", describeError(err));
  }
  // Name the protocol that went silent: "no SNMP response" is wrong for a ping-only router.
  const silent = d.pingOnly ? "no ICMP reply" : "no SNMP response";
  const log = await logDevice(
    d.id,
    online ? "info" : "warning",
    online ? `${typeLabel(d)} reachable` : `${typeLabel(d)} unreachable — ${silent}`,
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

// --- Threshold + event alerting -------------------------------------------------
// Router and UPS alerting is in deviceAlerts.js, checked against alert_rules and
// shared with the MikroTik poller.

// --- Per-device poll ------------------------------------------------------------

// A router with no community: ping is the whole sample (reachable, latency, loss).
// Unlike SNMP, the sample is written even when the device is down; those fields are
// all a ping-only router has, so skipping them would blank the chart during an outage.
async function pollRouterByPing(io, d) {
  const icmp = await icmpPing.ping(d.ip);

  // If ping itself could not run (no binary, or no permission, e.g. systemd's
  // NoNewPrivileges), reachable:false is not a measurement. Writing it would mark
  // every ping-only router offline at once. icmpPing has already logged why.
  // See audits/logging-monitoring-2026-08-25.md and ops/systemd/README.md.
  if (icmp.probeError) return;

  const sample = {
    reachable: icmp.reachable,
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

  await setReachable(io, d, icmp.reachable);
  if (isRemoved(d.id)) return;
  await writeNetworkSample(io, d, sample);
  // Safe with an empty sample: cpu/mem/clients are null and skipped, and there are no
  // interfaces. The unreachable alert comes from setReachable. Latency and loss are
  // not null on a down host (loss is 100%), so checkRouter only checks them while the
  // device answers.
  await deviceAlerts.checkRouter(io, d, sample);

  latestNetwork.set(Number(d.id), {
    status: icmp.reachable ? "Online" : "Offline",
    reachable: icmp.reachable,
    mode: "ping",
    descr: null,
    sysName: null,
    uptimeSeconds: null,
    cpuPercent: null,
    memPercent: null,
    latencyMs: icmp.latencyMs,
    packetLossPct: icmp.packetLossPct,
    interfaces: [],
  });
}

async function pollRouter(io, d) {
  if (d.pingOnly) return pollRouterByPing(io, d);

  const labels = await loadInterfaceLabels(d.id);
  // Started before the SNMP walk so the two overlap. icmpPing.ping never rejects, so
  // awaiting it later is safe, including on the failure path.
  const icmpPromise = icmpPing.ping(d.ip);

  let sample;
  try {
    sample = await collectRouter(d.id, connFor(d), labels); // throws if unreachable
  } catch (err) {
    // Say which failure it is: a dead router, or a live one with a wrong community or
    // blocked UDP 161. They need different fixes.
    const icmp = await icmpPromise;
    // If ping could not run, report only the SNMP failure; "host unreachable" would come
    // from the broken probe, not the device.
    if (icmp.probeError) {
      console.warn(
        `[SNMP_POLLER] ${d.name ?? d.ip}: SNMP failed and ICMP is unavailable ` +
          `(${icmp.probeError}) — cannot tell a dead router from a bad community string.`,
      );
    }
    err.message = icmp.reachable
      ? `${err.message} — but the host ANSWERS ICMP (${icmp.latencyMs} ms), so the device is up and SNMP is the problem: wrong community, SNMP not enabled, or UDP ${d.snmpPort || 161} blocked`
      : `${err.message} — and the host does not answer ICMP either, so the device or its link is down`;
    throw err;
  }

  // Latency and packet loss: a link that is up but losing packets looks healthy to SNMP.
  const icmp = await icmpPromise;
  sample.latencyMs = icmp.latencyMs;
  sample.packetLossPct = icmp.packetLossPct;

  await syncInterfaces(d.id, sample.interfaces);
  await setReachable(io, d, true);
  if (isRemoved(d.id)) return;
  await writeNetworkSample(io, d, sample);
  await deviceAlerts.checkRouter(io, d, sample);
  latestNetwork.set(Number(d.id), {
    status: "Online",
    reachable: true,
    mode: "snmp",
    latencyMs: sample.latencyMs,
    packetLossPct: sample.packetLossPct,
    // sysDescr/sysName (vendor/model/hostname) shown in the list and detail views. Cached
    // only, since there is no column for them; refilled on the first poll after a restart.
    descr: sample.descr ?? null,
    sysName: sample.sysName ?? null,
    uptimeSeconds: sample.uptimeSeconds,
    cpuPercent: sample.cpuPercent,
    memPercent: sample.memPercent,
    interfaces: sample.interfaces.map((i) => ({
      name: i.name,
      locationLabel: i.locationLabel ?? "",
      linkUp: Boolean(i.linkUp),
      adminUp: i.adminUp !== false,
      utilizationPct: i.utilizationPct ?? null,
      speedMbps: i.speedMbps ?? null,
      // Cumulative error counters — the UI shows the delta between polls, which is
      // what indicates a failing cable/SFP now (a lifetime total says nothing).
      rxErrors: i.rxErrors ?? null,
      txErrors: i.txErrors ?? null,
      rxBytes: i.rxBytes != null ? String(i.rxBytes) : null, // BigInt → string (JSON-safe)
      txBytes: i.txBytes != null ? String(i.txBytes) : null,
    })),
  });
}

async function pollUps(io, d) {
  const sample = await collectUps(connFor(d)); // throws if unreachable
  await setReachable(io, d, true);
  if (isRemoved(d.id)) return;
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
    onBypass: sample.onBypass,
    outputState: sample.outputState,
    // upsBatteryStatus (2 normal, 3 low, 4 depleted), cached so the list can show
    // battery health, which is separate from charge level.
    batteryStatus: sample.batteryStatus,
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
        // Unreachable or SNMP error for this device: log the reason, mark it offline and
        // continue. The reason tells "timed out" from "unknown community" from a bug.
        console.error(`[SNMP_POLLER] ${d.type} "${d.name}" (${d.ip}) poll failed:`, describeError(err));
        await setReachable(io, d, false);
      }
    }
  } catch (err) {
    console.error("[SNMP_POLLER] load error:", describeError(err));
  } finally {
    polling = false;
  }
}

/**
 * Poll one device right now, without waiting for the next cycle (up to
 * SNMP_POLL_INTERVAL_MS). Gives quick feedback after Add instead of a minute of an
 * empty panel.
 *
 * The interval is not reset, so adding several devices does not delay the others. It
 * runs alongside a cycle (`polling` is not checked); a device polled twice in a row
 * just gives a small counter change, which the rate math handles.
 *
 * Never throws; callers do not wait so the HTTP response is not held up. Returns
 * `{ ok, reason }`, which routes/network.js sends to the admin who added the device.
 * See deviceProbe.js for the check before a device is created.
 */
export async function pollDeviceNow(io, deviceId) {
  const id = Number(deviceId);
  try {
    const d = (await loadDevices()).find((x) => Number(x.id) === id);
    if (!d) return { ok: false, reason: "device not found" };
    try {
      if (d.type === "router") await pollRouter(io, d);
      else if (d.type === "ups") await pollUps(io, d);

      // Not every failure throws: pollRouterByPing records an unreachable ping-only router
      // as a normal result. So the result is read from the live cache, which every path
      // sets.
      const live = d.type === "ups" ? latestUps.get(id) : latestNetwork.get(id);
      if (live?.status === "Online") return { ok: true, reason: null };
      if (!live) {
        // pollRouterByPing writes nothing when ping could not run at all; that is not an outage.
        return { ok: false, reason: "the ICMP probe could not be run on the backend host — see the server log" };
      }
      return {
        ok: false,
        reason: d.pingOnly ? "no ICMP reply" : "no response",
      };
    } catch (err) {
      // Same as pollAll: log the reason, mark offline, continue. A device that fails its
      // first poll usually has a wrong IP, port or community.
      const reason = describeError(err);
      console.error(`[SNMP_POLLER] first poll of ${d.type} "${d.name}" (${d.ip}) failed:`, reason);
      await setReachable(io, d, false);
      return { ok: false, reason };
    }
  } catch (err) {
    const reason = describeError(err);
    console.error("[SNMP_POLLER] immediate poll error:", reason);
    return { ok: false, reason };
  }
}

// ─── Dashboard reads (GET /api/network, /api/ups) ───────────────────────────────

// All routers with their latest values (status, interfaces, uptime). `mode` tells
// the UI what kind of device it is: 'snmp' has the full read, 'ping' only
// reachability, latency and loss.
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
      descr: live?.descr ?? null, // sysDescr — vendor/model string
      sysName: live?.sysName ?? null, // sysName — the device's own hostname
      uptimeSeconds: live?.uptimeSeconds ?? null,
      cpuPercent: live?.cpuPercent ?? null,
      memPercent: live?.memPercent ?? null,
      latencyMs: live?.latencyMs ?? null,
      packetLossPct: live?.packetLossPct ?? null,
      interfaces: live?.interfaces ?? [],
      // Falls back to the DB fact rather than the live cache, so the mode is right
      // on the very first GET after a restart, before any poll has run.
      mode: live?.mode ?? (r.community ? "snmp" : "ping"),
      monitored: true, // every registered router is polled, one way or the other
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
      onBypass: live?.onBypass ?? null,
      outputState: live?.outputState ?? null,
      batteryStatus: live?.batteryStatus ?? null, // RFC 1628 enum: 2 normal, 3 low, 4 depleted
      temperature: live?.temperature ?? null,
      monitored: ["snmp", "network"].includes(r.commType),
    };
  });
}

// ─── Device registration (add / remove), admin, from the dashboard ─────────────
// loadDevices() runs every cycle, so a new device is polled within one interval
// (≤ SNMP_POLL_INTERVAL_MS) without a restart. A community is required for a UPS
// and optional for a router (blank = ICMP monitoring).

const trimOrNull = (v) => {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};

// Reject a device whose SNMP endpoint is already registered. An endpoint is
// (ip, port, community), not just the IP: one host can answer on several communities
// (the dev simulator does). A ping-only device has no community, so its identity is
// the IP alone; `= NULL` is never true in SQL, so it has its own branch.
//
// The community is compared in JS after decryption: it is stored as AES-GCM with a
// random IV, so `snmp_community = ?` would never match. The query narrows on
// (ip, port) first.
async function assertEndpointFree(conn, ip, snmpPort, community) {
  const [rows] = community
    ? await conn.query(
        `SELECT d.device_name, d.device_type, n.snmp_community
           FROM devices d
           JOIN device_network n ON n.device_id = d.device_id
          WHERE d.ip_address = ? AND n.snmp_port = ?`,
        [ip, snmpPort],
      )
    : await conn.query(
        `SELECT d.device_name, d.device_type, n.snmp_community
           FROM devices d
           JOIN device_network n ON n.device_id = d.device_id
          WHERE d.ip_address = ? AND (n.snmp_community IS NULL OR n.snmp_community = '')
          LIMIT 1`,
        [ip],
      );
  const dup = community
    ? rows.filter((r) => readCommunity(r.snmp_community) === community).slice(0, 1)
    : rows;
  if (dup.length) {
    throw badRequest(
      community
        ? `"${dup[0].device_name}" (${dup[0].device_type}) is already registered at ${ip}:${snmpPort} ` +
            `with that community string.`
        : `"${dup[0].device_name}" (${dup[0].device_type}) is already registered at ${ip} for ping monitoring.`,
    );
  }
}

// Validate the fields both device types share, or throw a 400. `communityRequired`
// is false for a router (blank means ICMP monitoring) and true for a UPS.
function parseCommon(input, { communityRequired = true } = {}) {
  const name = String(input?.name ?? "").trim();
  const ip = String(input?.ip ?? "").trim();
  const community = String(input?.community ?? "").trim();
  if (!name) throw badRequest("Device name is required.");
  if (!isValidIp(ip)) throw badRequest("A valid IPv4 address is required.");
  if (communityRequired && !community) {
    throw badRequest("SNMP community string is required for a UPS (there is no ping fallback for a battery).");
  }
  return {
    name,
    ip,
    community: community || null, // null → ICMP-only monitoring
    location: String(input?.location ?? "").trim() || "CSPC-ICTU Server Room",
    snmpPort: normalizePort(input?.snmpPort),
  };
}

// Register a router: the devices row (type router) and its device_network row, in
// one transaction. Returns it in the same shape as a getNetworkDevices() item.
async function addNetworkDevice(input) {
  // A blank community is allowed here and means "monitor this one by ping".
  const { name, ip, community, location, snmpPort } = parseCommon(input, { communityRequired: false });
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await assertEndpointFree(conn, ip, snmpPort, community);
    const [dev] = await conn.query(
      `INSERT INTO devices (ip_address, device_name, device_type, status, location)
       VALUES (?, ?, 'router', 'offline', ?)`,
      [ip, name, location],
    );
    const deviceId = dev.insertId;
    await conn.query(
      `INSERT INTO device_network (device_id, gateway, dns, network_segment, snmp_port, snmp_community)
       VALUES (?, '', '', ?, ?, ?)`,
      // Encrypted at rest — the column feeds the nightly mysqldump and whatever that
      // folder is synced offsite to. See services/communityCrypto.js.
      [deviceId, networkSegment(ip), snmpPort, writeCommunity(community)],
    );
    await conn.commit();
    await logDevice(
      deviceId,
      "info",
      community
        ? "Router registered for SNMP monitoring"
        : "Router registered for ICMP ping monitoring (no SNMP community)",
    );
    return {
      id: deviceId,
      name,
      ip,
      type: "router",
      location,
      status: "Offline",
      reachable: null,
      descr: null, // filled in by the first successful poll
      sysName: null,
      uptimeSeconds: null,
      cpuPercent: null,
      memPercent: null,
      latencyMs: null,
      packetLossPct: null,
      interfaces: [],
      mode: community ? "snmp" : "ping",
      monitored: true,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Register a UPS: devices (type ups), device_network and ups_details, in one
// transaction. communication_type must be snmp/network. Returns it in the same
// shape as a getUpsDevices() item.
async function addUpsDevice(input) {
  const { name, ip, community, location, snmpPort } = parseCommon(input);
  const commType = ["snmp", "network"].includes(input?.commType) ? input.commType : "snmp";
  const brand = trimOrNull(input?.brand);
  const model = trimOrNull(input?.model);
  const batteryCapacity = trimOrNull(input?.batteryCapacity);
  const serialNumber = trimOrNull(input?.serialNumber);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await assertEndpointFree(conn, ip, snmpPort, community);
    const [dev] = await conn.query(
      `INSERT INTO devices (ip_address, device_name, device_type, status, location)
       VALUES (?, ?, 'ups', 'offline', ?)`,
      [ip, name, location],
    );
    const deviceId = dev.insertId;
    await conn.query(
      `INSERT INTO device_network (device_id, gateway, dns, network_segment, snmp_port, snmp_community)
       VALUES (?, '', '', ?, ?, ?)`,
      // Encrypted at rest — the column feeds the nightly mysqldump and whatever that
      // folder is synced offsite to. See services/communityCrypto.js.
      [deviceId, networkSegment(ip), snmpPort, writeCommunity(community)],
    );
    await conn.query(
      `INSERT INTO ups_details (device_id, brand, model, battery_capacity, communication_type, serial_number)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [deviceId, brand, model, batteryCapacity, commType, serialNumber],
    );
    await conn.commit();
    await logDevice(deviceId, "info", "UPS registered for SNMP monitoring");
    return {
      id: deviceId,
      name,
      ip,
      location,
      brand,
      model,
      commType,
      batteryCapacity,
      status: "Offline",
      batteryChargePct: null,
      runtimeRemainingMin: null,
      loadPct: null,
      inputVoltage: null,
      outputVoltage: null,
      batteryVoltage: null,
      onBattery: null,
      temperature: null,
      monitored: true,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Remove a router/UPS: deleting the devices row cascades to device_network,
// ups_details and network_interfaces. Also clears the in-memory poll state so a
// reused id starts clean. Returns false if there is no such device. InfluxDB history
// is kept.
async function removeDevice(id, type) {
  const deviceId = Number(id);
  if (!Number.isInteger(deviceId)) throw badRequest("Invalid device id.");
  const [result] = await db.query(
    `DELETE FROM devices WHERE device_id = ? AND device_type = ?`,
    [deviceId, type],
  );
  if (result.affectedRows === 0) return false;

  markRemoved(deviceId); // a poll may already be in flight — see the tombstone note
  if (type === "ups") {
    latestUps.delete(deviceId);
  } else {
    latestNetwork.delete(deviceId);
    for (const key of prevIface.keys()) {
      if (key.startsWith(`${deviceId}:`)) prevIface.delete(key);
    }
  }
  alertBandState.resetDevice(deviceId); // severity bands
  deviceAlerts.resetDevice(deviceId); // link baselines / uptime / error counters
  return true;
}

// The last full poll's view of one UPS (or undefined). Read by upsPowerWatch.js as the
// baseline its quick check compares against.
function getLiveUps(id) {
  return latestUps.get(Number(id));
}

export default {
  pollAll,
  pollDeviceNow,
  getLiveUps,
  // Exported for services/reachabilitySweep.js, which decides when a device is
  // unreachable; the status change itself (row, log, socket event, alert) stays here.
  setReachable,
  collectRouter,
  collectUps,
  loadDevices,
  getNetworkDevices,
  getUpsDevices,
  addNetworkDevice,
  addUpsDevice,
  removeDevice,
  setInterfaceLabel,
};
