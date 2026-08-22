import snmp from "net-snmp";
import {
  UPS_OUTPUT_SOURCE,
  upsOutputState,
  isOnBattery,
  isOnBypass,
  isOutputOff,
  isProtected,
} from "./snmpUtils.js";

// ─── Thin net-snmp wrapper for the router/UPS poller ──────────────────────────
//
// Vendor-neutral by design: it speaks the *standard* MIBs (MIB-II system group,
// IF-MIB, UPS-MIB / RFC 1628) so it works across Cisco / HP / Aruba / TP-Link /
// APC / Eaton / … without per-vendor code. The poller (snmpPollerService) decides
// WHAT to read and how to shape it; this module only knows HOW to talk SNMP:
// open a session, GET scalars, walk a table column, and normalize values.
//
// SNMP version: v2c only. device_network stores a community string + port but has
// no v3 columns (no auth user / protocol / priv), so the DB models v2c. The v3
// branch is intentionally left as a single extension point in openSession() — add
// the credential columns + a createV3Session() call when an untrusted LAN needs it.

// ─── OID maps ─────────────────────────────────────────────────────────────────

// System group (MIB-II / RFC 1213) — universal across every SNMP-capable device.
export const SYS_OID = {
  sysDescr: "1.3.6.1.2.1.1.1.0", // OctetString — vendor/model description
  sysUpTime: "1.3.6.1.2.1.1.3.0", // TimeTicks — hundredths of a second since boot
  sysName: "1.3.6.1.2.1.1.5.0", // OctetString — admin-assigned name
};

// IF-MIB — per-interface status/counters. These are COLUMN base OIDs: append
// ".<ifIndex>" for one row, or walk the base to enumerate every interface. The HC
// (high-capacity, 64-bit) octet counters live in ifXTable and are the ones to use
// (Counter32 wraps in seconds on a gigabit link — see the design doc §5).
export const IF_OID = {
  ifNumber: "1.3.6.1.2.1.2.1.0", // scalar — interface count
  ifDescr: "1.3.6.1.2.1.2.2.1.2", // OctetString col — interface description
  ifAdminStatus: "1.3.6.1.2.1.2.2.1.7", // Integer col — 1=up 2=down 3=testing (DESIRED state)
  ifOperStatus: "1.3.6.1.2.1.2.2.1.8", // Integer col — 1=up 2=down 3=testing … (ACTUAL state)
  ifInErrors: "1.3.6.1.2.1.2.2.1.14", // Counter32 col
  ifOutErrors: "1.3.6.1.2.1.2.2.1.20", // Counter32 col
  ifName: "1.3.6.1.2.1.31.1.1.1.1", // OctetString col (ifXTable) — short name
  ifHCInOctets: "1.3.6.1.2.1.31.1.1.1.6", // Counter64 col — cumulative in-bytes
  ifHCOutOctets: "1.3.6.1.2.1.31.1.1.1.10", // Counter64 col — cumulative out-bytes
  ifHighSpeed: "1.3.6.1.2.1.31.1.1.1.15", // Gauge32 col — link speed in Mbit/s
};

// IF-MIB ifOperStatus enum (RFC 2863). Only `up` is treated as link-up.
export const IF_OPER_STATUS = { up: 1, down: 2, testing: 3, unknown: 4, dormant: 5, notPresent: 6, lowerLayerDown: 7 };

// IF-MIB ifAdminStatus enum (RFC 2863) — what the operator CONFIGURED, as opposed to
// what the port is doing. The classic NMS rule is "alert when adminStatus=up and
// operStatus=down": a port the operator shut down is not an incident. Absent on some
// agents, so a missing value is treated as enabled rather than as "disabled".
export const IF_ADMIN_STATUS = { up: 1, down: 2, testing: 3 };

// UPS-MIB (RFC 1628), base 1.3.6.1.2.1.33. Battery + output-source are scalars
// (append ".0"); the voltage/load values are per-line table columns (append ".1"
// for line 1, or walk). Units per the RFC are noted — the poller converts where
// the RFC stores a scaled integer (e.g. battery voltage in 0.1 V units).
export const UPS_OID = {
  upsBatteryStatus: "1.3.6.1.2.1.33.1.2.1.0", // 1=unknown 2=normal 3=low 4=depleted
  upsEstimatedMinutesRemaining: "1.3.6.1.2.1.33.1.2.3.0", // minutes
  upsEstimatedChargeRemaining: "1.3.6.1.2.1.33.1.2.4.0", // percent
  upsBatteryVoltage: "1.3.6.1.2.1.33.1.2.5.0", // 0.1 Volt DC (÷10 for volts)
  upsBatteryTemperature: "1.3.6.1.2.1.33.1.2.7.0", // degrees C (optional — many UPS omit)
  upsOutputSource: "1.3.6.1.2.1.33.1.4.1.0", // 3=normal 5=battery … (see UPS_OUTPUT_SOURCE)
  upsInputVoltage: "1.3.6.1.2.1.33.1.3.3.1.3", // RMS Volts — table col (per input line)
  upsOutputVoltage: "1.3.6.1.2.1.33.1.4.4.1.2", // RMS Volts — table col (per output line)
  upsOutputPercentLoad: "1.3.6.1.2.1.33.1.4.4.1.5", // percent — table col (per output line)
};

// UPS-MIB upsOutputSource enum (RFC 1628) + its interpreters. Defined in the PURE
// snmpUtils.js — they are reasoning about a value, not transport, and `npm test`
// can reach that file without net-snmp or a device. Re-exported here so the OIDs
// and the meaning of what they return stay one import away from each other.
//
// Imported and re-exported rather than `export … from`, because that form creates
// no LOCAL binding — the default-export object at the bottom of this file needs
// real ones.
export { UPS_OUTPUT_SOURCE, upsOutputState, isOnBattery, isOnBypass, isOutputOff, isProtected };

// ─── Sessions ─────────────────────────────────────────────────────────────────

export const DEFAULTS = { port: 161, timeout: 5000, retries: 1 };

// Open a v2c SNMP session to one device. Caller MUST closeSession() it (the poller
// opens one per device per cycle and closes it in a finally). Throws only on bad
// args — a dead/unreachable device surfaces later as a timeout from get()/walk().
export function openSession({ host, community = "public", port, timeout, retries } = {}) {
  if (!host) throw new Error("snmpClient.openSession: host is required");
  return snmp.createSession(host, community || "public", {
    port: port ?? DEFAULTS.port,
    version: snmp.Version2c,
    timeout: timeout ?? DEFAULTS.timeout,
    retries: retries ?? DEFAULTS.retries,
    transport: "udp4",
  });
}

// Close a session, swallowing the error if it was already closed/torn down.
export function closeSession(session) {
  try {
    session?.close();
  } catch {
    /* already closed */
  }
}

// ─── Value normalization ──────────────────────────────────────────────────────

// Convert a varbind's raw value into a friendly JS value:
//   OctetString → utf8 string,  Counter64 → BigInt (precision-safe),
//   OID → string,  everything else (Integer/Counter32/Gauge/TimeTicks) → number.
// Counter64 stays a BigInt so an 8-byte octet counter never loses precision —
// the InfluxDB writer must use uintField() for these (see design doc §5).
function normalize(vb) {
  const T = snmp.ObjectType;
  switch (vb.type) {
    case T.OctetString:
      return Buffer.isBuffer(vb.value) ? vb.value.toString("utf8") : String(vb.value ?? "");
    case T.Counter64:
      if (Buffer.isBuffer(vb.value)) {
        return vb.value.length === 8 ? vb.value.readBigUInt64BE(0) : BigInt("0x" + (vb.value.toString("hex") || "0"));
      }
      return BigInt(vb.value ?? 0);
    case T.OID:
      return String(vb.value ?? "");
    default:
      return vb.value; // Integer / Counter32 / Gauge32 / TimeTicks → JS number
  }
}

// ─── Reads ────────────────────────────────────────────────────────────────────

// SNMP GET one or more scalar OIDs. Resolves to a plain map { <oid>: value }.
// A per-OID error (noSuchObject / noSuchInstance — i.e. the device doesn't expose
// that optional OID) becomes `null` for that OID so one missing value never fails
// the whole read. REJECTS only on a transport-level failure (timeout / no route),
// which is how the poller detects an unreachable device.
export function get(session, oids) {
  const list = Array.isArray(oids) ? oids : [oids];
  return new Promise((resolve, reject) => {
    session.get(list, (error, varbinds) => {
      if (error) return reject(error);
      const out = {};
      for (const vb of varbinds) out[vb.oid] = snmp.isVarbindError(vb) ? null : normalize(vb);
      resolve(out);
    });
  });
}

// Walk one OID column (e.g. IF_OID.ifName) and resolve to rows keyed by the
// trailing table index, so callers can join columns by index:
//   walkColumn(s, IF_OID.ifName) → { "1": "ether1", "2": "ether2", … }
// REJECTS on a transport failure (same contract as get()).
export function walkColumn(session, baseOid, { maxRepetitions = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const out = {};
    const onFeed = (varbinds) => {
      for (const vb of varbinds) {
        if (snmp.isVarbindError(vb)) continue;
        const index = vb.oid.slice(baseOid.length + 1); // strip "base." → bare index
        out[index] = normalize(vb);
      }
    };
    const onDone = (error) => (error ? reject(error) : resolve(out));
    session.subtree(baseOid, maxRepetitions, onFeed, onDone);
  });
}

export default {
  SYS_OID,
  IF_OID,
  IF_OPER_STATUS,
  IF_ADMIN_STATUS,
  UPS_OID,
  UPS_OUTPUT_SOURCE,
  upsOutputState,
  isOnBattery,
  isOnBypass,
  isOutputOff,
  isProtected,
  DEFAULTS,
  openSession,
  closeSession,
  get,
  walkColumn,
};
