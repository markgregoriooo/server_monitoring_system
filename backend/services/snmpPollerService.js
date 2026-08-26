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
import agentService from "./agentService.js";
import deviceAlerts from "./deviceAlerts.js";
import alertBandState from "./alertBandState.js";
import { writeNetworkSample } from "./writeNetworkMetrics.js";
import { writeUpsSample } from "./writeUpsMetrics.js";
import { logDevice } from "./deviceLogs.js";
import {
  badRequest,
  numOrNull,
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

// ─── SNMP poller: routers (IF-MIB) + UPS (UPS-MIB), pull-based ─────────────────
//
// The mirror image of the Go-agent pipeline: instead of agents PUSHing metrics,
// this service PULLs them by polling each device over SNMP on a timer. One service
// covers both classes — only the OID set differs. server.js drives pollAll() on an
// interval (like the offline sweep). Because polling IS the heartbeat, there's no
// separate offline sweep: each cycle directly knows whether a device answered, and
// flips devices.status accordingly.
//
// Two collection modes for a router, decided per device by whether it has a
// community string (see loadDevices):
//
//   SNMP  — the full read: interfaces, traffic counters, link state, uptime.
//           ICMP runs alongside it and adds latency/packet loss, which SNMP cannot
//           express: an SNMP walk either answers or times out, so a link that is up
//           but dropping 40% of packets looks perfectly healthy until it finally
//           flips to a flat Offline.
//   PING  — ICMP only: reachable, latency, loss. The design doc's "universal
//           fallback" (§4), and the only way to monitor ISP-owned CPE, which is
//           locked down and will not answer SNMP at all.
//
// A UPS is always SNMP — communication_type must be snmp/network, and pinging a UPS
// would tell you its management card has power while saying nothing about the
// battery, which is the entire reason the device is monitored.

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

const firstValue = (m) => {
  const k = Object.keys(m)[0];
  return k === undefined ? null : m[k];
};
// Build the SNMP session parameters for a device.
//
// ⚠️ NO DEFAULT COMMUNITY. This read `d.community || "public"`, which silently
// substituted the best-known default credential in existence for a missing one. It was
// unreachable in practice — loadDevices() filters a UPS without a community out
// entirely, and pollRouter() sends a router without one down the ICMP path before it
// gets here — but that is exactly what makes a fallback dangerous: it is invisible
// until the invariant it depends on changes, and then the poller starts probing a
// production device with a guessed credential and reports the result as monitoring.
// Fail loudly instead, so a bug upstream surfaces as a bug rather than as a device
// that mysteriously answers (or does not).
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
    // ifAdminStatus is what the operator CONFIGURED. A port shut down on purpose
    // reports operStatus=down like an unplugged one, and alerting on that is how a
    // deliberately-disabled port became the noisiest thing on the dashboard.
    // Optional: some agents omit the column, and a missing value must read as
    // "enabled" so a sparse agent can't silence a genuine link failure.
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

      // utilization_pct from the per-interface delta vs the previous cycle.
      //
      // Ethernet links are FULL-DUPLEX: rx and tx each get the full link speed, so
      // the busier DIRECTION is the saturation measure — not their sum. Summing them
      // reports a 100 Mbit/s link carrying 60 Mbit/s each way as 120% (clamped to
      // 100%) when neither direction is above 60%, which false-fires `link_util`.
      // This matches the LibreNMS/Cacti convention of graphing in/out separately and
      // alerting on the worse one. (Half-duplex would want the sum, but IF-MIB
      // duplex state isn't collected and modern switched gear is full-duplex.)
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
        // ifHighSpeed (Mbit/s). Carried through to the UI so a port can show its
        // negotiated speed — a 1 Gb link sitting at 10 Mb is a duplex/cable fault
        // that a utilization % alone hides completely. 0 = unknown, sent as null.
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

    // Every reading is range-checked against UPS_BOUNDS (RFC 1628 where it states a
    // range, physical plausibility where it doesn't) — out of range means a firmware
    // sentinel, not a measurement, and becomes null. See snmpUtils.inRange.
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
      // Where the load is actually fed from. `onBattery` alone cannot express
      // BYPASS — the load on raw mains with the inverter and battery cut out of the
      // path — which reported false here and read as a healthy UPS. See
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

// Load the routers + UPS to poll, with their connection details, and tag each with
// the mode it will be collected in.
//
// A ROUTER needs only an IP: with a community it is polled over SNMP, without one
// it falls back to ICMP (`pingOnly`). It used to need both, which silently dropped
// every router that cannot run SNMP — and at CSPC that is the ISP-owned PLDT CPE,
// i.e. the only non-MikroTik router on site (see router-ups-client-answers.md §3).
// The feature had no device left to show.
//
// A UPS still needs an IP + community + communication_type snmp/network. There is
// no ping fallback for one: a UPS that answers a ping tells you its management card
// has power, which is not what anybody is monitoring a battery for.
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

// Record the interfaces this poll discovered. Nothing used to write this table, so
// `location_label` could never be set for a dashboard-registered router — the admin
// had no list of port names to label in the first place. Now each poll upserts what
// the device actually reports, which both populates that list and keeps is_active
// current as ports are patched in and out.
//
// Deliberately preserves location_label on conflict: the label is human-authored and
// must survive every re-poll. Needs the unique key from
// the UNIQUE(device_id, interface_name) key that ships in v13_cspc-ictu-monitoring-system.sql —
// without it ON DUPLICATE KEY
// never matches and this would append a row per interface per cycle, so the whole
// thing is skipped (and warned once) when the key is missing.
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

// Set the human label for one discovered interface (admin, from the router detail
// page). Returns false when that device/interface pair isn't one we've discovered —
// callers turn that into a 404 rather than silently creating an orphan row.
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
  // Keep the live cache in step with reachability so the list endpoint reflects
  // an offline device immediately (the success path caches richer data below).
  // Both branches PRESERVE the last successful readings and only overlay the down
  // state: replacing the router entry wholesale (interfaces: []) rendered an offline
  // router with no interfaces at all, discarding exactly the context an operator
  // needs to see what was connected when it dropped. The UPS branch already did
  // this; the two are now consistent.
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
  // Name the protocol that actually fell silent. "no SNMP response" on a ping-only
  // router describes a poll that was never attempted, and sends whoever reads the log
  // off to check a community string the device does not have.
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
// Router (link utilization + interface-down) and UPS (charge/runtime/load + on-battery)
// alerting now lives in deviceAlerts.js: each metric is evaluated against the
// configurable alert_rules (alertRulesService) and raised through the real notification
// pipeline (bell/email/Alerts page), shared with the MikroTik poller. This replaced the
// old hardcoded per-condition checks that used to live here.

// --- Per-device poll ------------------------------------------------------------

// A router with no community string: ICMP is the entire sample. No interfaces, no
// uptime, no traffic — just whether it answers, how fast, and how much it drops.
//
// Unlike the SNMP path this writes the sample even when the device is DOWN. Total
// loss is a measurement, not an error: `reachable` and `packet_loss_pct` are the
// only two things a no-SNMP router ever gives us, so dropping the point during an
// outage would blank the chart at exactly the moment it is worth reading. (The SNMP
// path has no equivalent — an SNMP timeout yields no partial sample to write.)
async function pollRouterByPing(io, d) {
  const icmp = await icmpPing.ping(d.ip);

  // A BROKEN PROBE IS NOT AN OUTAGE. If ICMP could not be attempted at all — no `ping`
  // binary, or the account cannot open a raw socket (systemd's NoNewPrivileges blocks
  // the setuid/cap_net_raw it needs) — then `reachable:false` is not a measurement, it
  // is the absence of one. Writing it would mark every ping-only router Offline and
  // alert on all of them simultaneously: a fleet-wide outage that exists only in the
  // monitoring. icmpPing has already logged the cause once.
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
  await writeNetworkSample(io, d, sample);
  // Safe with an empty sample: every numeric rule reads null → NaN and bails, and the
  // per-interface loop doesn't run. The alert that matters here — the device going
  // unreachable — is already raised by setReachable → deviceAlerts.checkReachability.
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
  // Started before the SNMP walk so the two overlap rather than adding their
  // latencies together. icmpPing.ping never rejects, so this promise is always safe
  // to await later — including on the SNMP failure path below.
  const icmpPromise = icmpPing.ping(d.ip);

  let sample;
  try {
    sample = await collectRouter(d.id, connFor(d), labels); // throws if unreachable
  } catch (err) {
    // Say WHICH of the two failures this is. "Request timed out" alone cannot
    // distinguish a dead router from a live one with the wrong community string or a
    // blocked UDP 161 — and those need opposite fixes. §9 of the design doc sends the
    // operator to run snmpwalk by hand precisely because the log couldn't tell them.
    const icmp = await icmpPromise;
    // With ICMP unavailable, the combined verdict below would read "SNMP failed AND the
    // host is unreachable" — the second half being an artefact of the broken probe, not
    // a finding. Fall back to reporting only what was actually observed.
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

  // Latency and packet loss are what SNMP cannot express. An SNMP walk either
  // answers or times out, so a link that is up but dropping 40% of packets reads as
  // perfectly healthy right until it flips to a flat Offline.
  const icmp = await icmpPromise;
  sample.latencyMs = icmp.latencyMs;
  sample.packetLossPct = icmp.packetLossPct;

  await syncInterfaces(d.id, sample.interfaces);
  await setReachable(io, d, true);
  await writeNetworkSample(io, d, sample);
  await deviceAlerts.checkRouter(io, d, sample);
  latestNetwork.set(Number(d.id), {
    status: "Online",
    reachable: true,
    mode: "snmp",
    latencyMs: sample.latencyMs,
    packetLossPct: sample.packetLossPct,
    // sysDescr/sysName were polled every cycle and thrown away. They're the only
    // vendor/model/hostname the standard MIBs give us — the router equivalent of the
    // server path's server_specs — so carry them through to the list + detail views.
    // Cache-only (no schema column exists for a router's model); they repopulate on
    // the first poll after a restart, same as every other live value here.
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
    // RFC 1628 upsBatteryStatus (2 normal, 3 low, 4 depleted). Already drives the
    // battery-replace alert and the broadcast; cached here too so the list endpoint
    // can surface battery HEALTH, which is distinct from charge level — a battery at
    // 100% charge can still report "replace".
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
        // Unreachable / SNMP error for this device — mark offline, keep going.
        // The reason is logged, not swallowed: "Request timed out" (device down or
        // firewalled), "Unknown community" (wrong credential) and a genuine bug in
        // the collector all previously looked identical from outside — every one just
        // showed up as a device silently sitting Offline with no way to tell which.
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

// ─── Dashboard reads (GET /api/network, /api/ups) ───────────────────────────────

// All routers + their latest live values (status, interfaces, uptime).
//
// `mode` tells the UI which kind of device it is looking at: 'snmp' gets the full
// read, 'ping' gets reachability, latency and loss and nothing else. Both are
// monitored — the field used to be `monitored: Boolean(community)`, which labelled
// a ping-only router "not yet pollable" back when that was true. It no longer is,
// and a page that renders an empty interface table for a device that will never
// report interfaces reads as broken rather than as a different kind of device.
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

// ─── Device registration (add / remove) — admin, from the dashboard ─────────────
//
// The poller is data-driven: loadDevices() runs every cycle, so a device added here
// starts being polled within one interval (≤ SNMP_POLL_INTERVAL_MS) with NO restart.
// These replace the old hand-written seed SQL, so the
// dashboard's "Add router / Add UPS" replaces hand-writing SQL.
//
// A community string is REQUIRED for a UPS and OPTIONAL for a router: leaving it
// blank registers the router for ICMP monitoring instead. It used to be required for
// both, which meant the form refused the one device class the fallback exists for —
// an ISP-owned CPE that will never hand out a community string.

const trimOrNull = (v) => {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};

// Reject a device whose SNMP endpoint is already registered. The identity of an
// endpoint is (ip, port, community) — NOT the IP alone: one host can legitimately
// expose several SNMP contexts on different communities, which is exactly what the
// dev simulator does (router and UPS both answer on 127.0.0.1:1161, told apart by
// community). An exact triple match is unambiguously a double-registration, which
// would poll the box twice and split its history across two device_id-tagged series.
// A PING-ONLY device has no community, so its endpoint identity collapses to the IP
// alone — there is no second ICMP context to tell two entries at one address apart.
// `= NULL` is never true in SQL, so this needs its own branch: without it the guard
// silently matched nothing and every re-submit of the add form created another
// duplicate router.
// ⚠️ The community half of the comparison happens in JS, not in SQL, and has to.
// `snmp_community` is now AES-256-GCM ciphertext with a random IV (communityCrypto.js),
// so the same string encrypts to a different value every time and `n.snmp_community = ?`
// would match nothing — turning this guard into a no-op and letting every re-submit of
// the add form create another duplicate router, which is the precise bug the `= NULL`
// branch below was written to fix. So the query narrows on (ip, port) — indexed, and a
// handful of rows at this scale — and the credential is compared after decryption.
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

// Validate the fields shared by both device classes, or throw a 400.
//
// `communityRequired` is false for a ROUTER, where a blank community is a real
// choice — it registers the device for ICMP monitoring instead. It stays true for a
// UPS: there is no ping fallback for a battery, so a UPS without a community would
// be a row that can never report the values it exists to report.
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

// Register a router/switch: devices (type router) + its device_network row, in one
// transaction. Returns the row shaped exactly like a getNetworkDevices() item so the
// caller can broadcast/return it directly.
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

// Register a UPS: devices (type ups) + device_network + ups_details, in one
// transaction. communication_type must be snmp/network (the poller only reads those).
// Returns the row shaped like a getUpsDevices() item.
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

// Decommission a router/UPS: delete the devices row (device_network / ups_details /
// network_interfaces cascade via their FKs). Also drops this device's in-memory poll
// state so a later id reuse can't inherit stale counters/bands. Returns false if no
// such device of that type. InfluxDB history is left intact.
async function removeDevice(id, type) {
  const deviceId = Number(id);
  if (!Number.isInteger(deviceId)) throw badRequest("Invalid device id.");
  const [result] = await db.query(
    `DELETE FROM devices WHERE device_id = ? AND device_type = ?`,
    [deviceId, type],
  );
  if (result.affectedRows === 0) return false;

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

export default {
  pollAll,
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
