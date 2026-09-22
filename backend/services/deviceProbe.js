// The I/O half of "can this device be monitored, and HOW?" — ICMP + the three MIB
// questions, run against one address, with no DB and no InfluxDB touched.
//
// It is the engine behind BOTH `npm run probe` (scripts/probeDevice.js) and the
// **Test connection** button on the Add router / Add UPS forms. One implementation on
// purpose: the CLI's own header has always claimed "there is nothing to install and no
// second implementation to drift", and a probe that disagreed with the form would be
// worse than no probe at all.
//
// Runs the SAME code the poller runs (snmpClient + icmpPing), so a pass here means the
// poller will succeed for the same reasons — and a failure names the reason the poller
// would otherwise have written only to the server console.
//
// Never throws. Every branch is a measurement: "no answer" is a result, not an error,
// exactly as in icmpPing. The verdict itself lives in the pure deviceProbeVerdict.js.

import { ping } from "./icmpPing.js";
import client, { SYS_OID, IF_OID, UPS_OID, upsOutputState } from "./snmpClient.js";
import { isValidIp, normalizePort } from "./snmpUtils.js";
import { verdictFor } from "./deviceProbeVerdict.js";

// Tighter than the poller's own budget, because a human is watching a spinner. The
// worst case (nothing at the address at all) is ICMP + one SNMP attempt, not four.
const SNMP_TIMEOUT_MS = 2500;
const SNMP_RETRIES = 0;
const PING_COUNT = 2;

/** One SNMP session, opened and reliably closed, with "no answer" folded into null. */
async function ask(conn, fn) {
  const session = client.openSession(conn);
  try {
    return await fn(session);
  } catch (err) {
    return { __error: err?.message || String(err) };
  } finally {
    client.closeSession(session);
  }
}

const failed = (r) => r == null || r.__error != null;

/**
 * Probe one address.
 *
 * @param {string} ip
 * @param {object} opts
 * @param {string} [opts.community] blank/omitted = do NOT attempt SNMP at all. That is
 *   not a shortcut: a blank community on the Add router form REGISTERS the device for
 *   ICMP monitoring, so guessing "public" here would report a capability the saved
 *   device is never going to use. The CLI passes an explicit default instead.
 * @param {number|string} [opts.port]
 * @param {'router'|'ups'} [opts.expect] what the caller is trying to register.
 * @param {number} [opts.pingCount]
 * @returns {Promise<object>} measurements + verdict; `ok:false` with `error` on bad input.
 */
export async function probe(ip, { community = "", port, expect = "router", pingCount = PING_COUNT } = {}) {
  const host = String(ip ?? "").trim();
  if (!host) return { ok: false, error: "IP address is required." };
  // Validated the same way addNetworkDevice validates it, so the form can never pass a
  // probe and then be refused on save.
  if (!isValidIp(host)) return { ok: false, error: `"${host}" is not a valid IPv4 address.` };

  // normalizePort THROWS on a typo rather than coercing — the right call on the save
  // path, but this function's contract is that every outcome is a result, so the
  // message is turned into one. The form then shows the same text either way.
  let snmpPort;
  try {
    snmpPort = normalizePort(port);
  } catch (err) {
    return { ok: false, error: err?.message || "Invalid SNMP port." };
  }
  const comm = String(community ?? "").trim();
  const conn = { host, community: comm, port: snmpPort, timeout: SNMP_TIMEOUT_MS, retries: SNMP_RETRIES };

  // ── 1. ICMP ────────────────────────────────────────────────────────────────
  // First, because nothing can refuse a ping: a failure here means the address is
  // wrong or the host is down, and every SNMP result below would then be noise.
  const icmp = await ping(host, { count: pingCount });

  const out = {
    ok: true,
    ip: host,
    port: snmpPort,
    communityGiven: Boolean(comm),
    icmp: {
      reachable: icmp.reachable,
      latencyMs: icmp.latencyMs ?? null,
      packetLossPct: icmp.packetLossPct ?? null,
    },
    snmp: { attempted: Boolean(comm), answered: false, sysName: null, sysDescr: null, uptimeSeconds: null, error: null },
    ifCount: 0,
    ifNames: [],
    ups: { isUps: false, chargePct: null, runtimeMin: null, outputState: null },
  };

  if (!comm) {
    out.verdict = verdictFor(
      { icmpReachable: icmp.reachable, snmpAnswered: false },
      { expect, communityGiven: false },
    );
    return out;
  }

  // ── 2. Does SNMP answer at all? ────────────────────────────────────────────
  // "Answered" means the transport worked — the GET did not time out. Whether the
  // system group has any CONTENTS is a separate question, and conflating the two is
  // what once made the dev UPS (UPS-MIB only, empty MIB-II) read as unmonitorable.
  const sys = await ask(conn, (s) =>
    client.get(s, [SYS_OID.sysDescr, SYS_OID.sysName, SYS_OID.sysUpTime]),
  );
  if (failed(sys)) {
    out.snmp.error = sys?.__error ?? "no response";
  } else {
    out.snmp.answered = true;
    out.snmp.sysDescr = sys[SYS_OID.sysDescr] != null ? String(sys[SYS_OID.sysDescr]).replace(/\s+/g, " ") : null;
    out.snmp.sysName = sys[SYS_OID.sysName] != null ? String(sys[SYS_OID.sysName]) : null;
    if (sys[SYS_OID.sysUpTime] != null) out.snmp.uptimeSeconds = Number(sys[SYS_OID.sysUpTime]) / 100;
  }

  // ── 3 & 4. IF-MIB and UPS-MIB, asked independently ─────────────────────────
  // Both are asked whenever SNMP answered at ALL, not only when the system group did,
  // because a device may implement any subset of MIBs.
  if (out.snmp.answered) {
    const names = await ask(conn, (s) => client.walkColumn(s, IF_OID.ifName));
    if (!failed(names)) {
      const list = Object.values(names).map(String);
      out.ifCount = list.length;
      out.ifNames = list.slice(0, 8);
    }

    const u = await ask(conn, (s) =>
      client.get(s, [
        UPS_OID.upsEstimatedChargeRemaining,
        UPS_OID.upsEstimatedMinutesRemaining,
        UPS_OID.upsOutputSource,
      ]),
    );
    if (!failed(u)) {
      const charge = u[UPS_OID.upsEstimatedChargeRemaining];
      const src = u[UPS_OID.upsOutputSource];
      // This is what separates "a UPS on the network" from "a UPS we can actually
      // read" — a unit whose card only speaks its vendor's cloud app passes step 2
      // and fails here.
      out.ups.isUps = charge != null || src != null;
      out.ups.chargePct = charge != null ? Number(charge) : null;
      const mins = u[UPS_OID.upsEstimatedMinutesRemaining];
      out.ups.runtimeMin = mins != null ? Number(mins) : null;
      out.ups.outputState = src != null ? upsOutputState(src) : null;
    }
  }

  out.verdict = verdictFor(
    {
      icmpReachable: icmp.reachable,
      snmpAnswered: out.snmp.answered,
      ifCount: out.ifCount,
      isUps: out.ups.isUps,
    },
    { expect, communityGiven: true },
  );
  return out;
}

export default { probe };
