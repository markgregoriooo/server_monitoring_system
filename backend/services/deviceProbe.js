// Checks whether a device can be monitored, and how: ping, then the MIB-II, IF-MIB
// and UPS-MIB questions for one address. No database access. Used by both
// `npm run probe` and the Test connection button on the Add router / Add UPS
// forms, and uses the same snmpClient/icmpPing as the poller, so a pass here means
// polling will work. Never throws: "no answer" is a result. The verdict is in
// deviceProbeVerdict.js.

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
 * @param {string} [opts.community] blank/omitted = skip SNMP. On the Add router
 *   form a blank community means ICMP-only monitoring, so there is nothing to check
 *   over SNMP. The CLI passes its own default.
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

  // normalizePort throws on bad input; turn that into a result.
  let snmpPort;
  try {
    snmpPort = normalizePort(port);
  } catch (err) {
    return { ok: false, error: err?.message || "Invalid SNMP port." };
  }
  const comm = String(community ?? "").trim();
  const conn = { host, community: comm, port: snmpPort, timeout: SNMP_TIMEOUT_MS, retries: SNMP_RETRIES };

  // ── 1. ICMP ────────────────────────────────────────────────────────────────
  // First: if ping fails, the address is wrong or the host is down.
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
  // "Answered" means the GET did not time out; the system group may still be empty
  // (the dev UPS has only UPS-MIB).
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

  // ── 3 & 4. IF-MIB and UPS-MIB, asked separately ─────────────────────────
  // Asked whenever SNMP answered, since a device may implement any subset.
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
      // A UPS whose card only talks to its vendor's app passes step 2 and fails here.
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
