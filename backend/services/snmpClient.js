import snmp from "net-snmp";
import {
  UPS_OUTPUT_SOURCE,
  upsOutputState,
  isOnBattery,
  isOnBypass,
  isOutputOff,
  isProtected,
} from "./snmpUtils.js";

// ─── net-snmp wrapper for the router/UPS poller ──────────────────────────
// Uses only standard MIBs (MIB-II system, IF-MIB, UPS-MIB / RFC 1628), so it works
// across vendors without special code. snmpPollerService decides what to read; this
// module opens sessions, GETs scalars, walks table columns and normalises values.
//
// SNMP v2c only: device_network has a community and port but no v3 columns. v3 would
// need those columns plus a createV3Session() call in openSession().

// ─── OID maps ─────────────────────────────────────────────────────────────────

// System group (MIB-II / RFC 1213) — universal across every SNMP-capable device.
export const SYS_OID = {
  sysDescr: "1.3.6.1.2.1.1.1.0", // OctetString — vendor/model description
  sysUpTime: "1.3.6.1.2.1.1.3.0", // TimeTicks — hundredths of a second since boot
  sysName: "1.3.6.1.2.1.1.5.0", // OctetString — admin-assigned name
};

// IF-MIB per-interface status and counters. Column base OIDs: add ".<ifIndex>" for
// one row or walk the base for all. Use the 64-bit HC counters from ifXTable
// (Counter32 wraps within seconds on gigabit links).
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

// ifAdminStatus (RFC 2863): what the operator configured, not what the port is
// doing. Alert only when admin is up and oper is down. Missing = treat as enabled.
export const IF_ADMIN_STATUS = { up: 1, down: 2, testing: 3 };

// UPS-MIB (RFC 1628), base 1.3.6.1.2.1.33. Battery and output source are scalars
// (add ".0"); voltage/load are per-line table columns (add ".1" for line 1, or walk).
// The poller converts scaled integers (e.g. battery voltage in 0.1 V).
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

// upsOutputSource enum and helpers, defined in snmpUtils.js (no imports, tested) and
// re-exported here. Imported then re-exported, not `export … from`, because the
// default export object below needs local bindings.
export { UPS_OUTPUT_SOURCE, upsOutputState, isOnBattery, isOnBypass, isOutputOff, isProtected };

// ─── Sessions ─────────────────────────────────────────────────────────────────

export const DEFAULTS = { port: 161, timeout: 5000, retries: 1 };

// Open a v2c SNMP session to one device. The caller must closeSession() it (the
// poller closes it in a finally). Only throws on bad arguments; a dead device shows
// up later as a timeout.
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

// Convert a raw varbind value:
//   OctetString → utf8 string,  Counter64 → BigInt (keeps precision),
//   OID → string,  everything else (Integer/Counter32/Gauge/TimeTicks) → number.
// Counter64 values must be written to InfluxDB with uintField().
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

// SNMP GET for one or more scalar OIDs; resolves to { <oid>: value }. An OID the
// device does not have (noSuchObject / noSuchInstance) becomes null, so one missing
// value does not fail the read. Rejects only on a transport failure (timeout, no
// route), which is how an unreachable device is detected.
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

// Walk one OID column (e.g. IF_OID.ifName) and return rows keyed by table index:
//   walkColumn(s, IF_OID.ifName) → { "1": "ether1", "2": "ether2", … }
// Rejects on a transport failure, like get().
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
