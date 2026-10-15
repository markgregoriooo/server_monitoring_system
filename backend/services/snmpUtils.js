// ─── Helpers for the SNMP router/UPS path ────────────────────────────────
// No imports, so backend/tests can run them. snmpPollerService uses these directly,
// so what is tested is what runs.

// ─── Validation / normalization ───────────────────────────────────────────────

// A 400 the Express error handler surfaces to the client (it reads `err.status`).
export function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

export const numOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// numOrNull plus a range check. UPS firmware often reports a placeholder (-1,
// 0xFFFF, …) when it cannot compute a value, so an out-of-range reading is dropped.
// null skips the InfluxDB field and deviceAlerts.evalMetric, so a placeholder cannot
// trigger an alert.
export const inRange = (v, min, max) => {
  const n = numOrNull(v);
  return n == null || n < min || n > max ? null : n;
};

// Bounds for the UPS-MIB readings. RFC 1628 ranges where it gives one; otherwise
// (voltage, temperature) a generous plausible limit.
export const UPS_BOUNDS = {
  batteryChargePct: [0, 100], // RFC 1628: INTEGER (0..100) percent
  runtimeRemainingMin: [0, 44_640], // RFC: non-negative minutes; cap at 31 days
  loadPct: [0, 200], // RFC 1628: INTEGER (0..200) percent
  voltage: [0, 1000], // RMS volts — 3-phase line-to-line reaches ~400
  batteryVoltageDeci: [0, 10_000], // 0.1 V DC units → 0..1000 V
  batteryStatus: [1, 4], // RFC enum: 1 unknown, 2 normal, 3 low, 4 depleted
  temperatureC: [-40, 100], // battery-plausible range
};

// ─── UPS output source (RFC 1628 upsOutputSource) ─────────────────────────────
// Where the load is being powered from. Only two of the seven values mean all is well.
// Kept here rather than in snmpClient.js so it can be tested without net-snmp.
export const UPS_OUTPUT_SOURCE = {
  other: 1,
  none: 2,
  normal: 3,
  bypass: 4,
  battery: 5,
  booster: 6,
  reducer: 7,
};

// Map the seven raw values to states someone would act on:
//
//   normal   mains, through the inverter; protected
//   battery  mains lost, running on battery
//   bypass   load on raw mains, around the inverter and battery. Still running,
//            but with no protection: a mains drop now takes it all down. Caused by
//            overload, overheating, a fault or the maintenance bypass switch.
//   off      output switched off; the load has no power
//   avr      mains present but out of range, being boosted or trimmed. Still
//            protected.
//   unknown  other(1), or anything not in the enum
export function upsOutputState(v) {
  switch (Number(v)) {
    case UPS_OUTPUT_SOURCE.normal:
      return "normal";
    case UPS_OUTPUT_SOURCE.battery:
      return "battery";
    case UPS_OUTPUT_SOURCE.bypass:
      return "bypass";
    case UPS_OUTPUT_SOURCE.none:
      return "off";
    case UPS_OUTPUT_SOURCE.booster:
    case UPS_OUTPUT_SOURCE.reducer:
      return "avr";
    default:
      return "unknown";
  }
}

// True when the UPS is drawing from its battery (an active power event).
export const isOnBattery = (v) => upsOutputState(v) === "battery";

// True when the load is on raw mains with no protection. isOnBattery only checks
// battery(5), so bypass used to look normal.
export const isOnBypass = (v) => upsOutputState(v) === "bypass";

// True when the UPS is not feeding the load at all.
export const isOutputOff = (v) => upsOutputState(v) === "off";

// Is the load protected right now? Written as "not one of the three unprotected
// states", so `unknown` (other(1) or a value outside the enum) is not treated as an
// outage.
export const isProtected = (v) => !["battery", "bypass", "off"].includes(upsOutputState(v));

// SNMP port: blank → 161; otherwise must be a valid port. Throws instead of
// guessing, so a typo shows on the form.
export function normalizePort(v) {
  if (v == null || v === "") return 161;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw badRequest(`SNMP port must be a whole number between 1 and 65535 (got "${v}").`);
  }
  return n;
}

export function isValidIp(ip) {
  if (typeof ip !== "string") return false;
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(m) && m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
}

// A /24 segment string from an IPv4 address ("" if unknown). Also used by
// agentService, so both write network_segment the same way.
export function networkSegment(ip) {
  const m = typeof ip === "string" && ip.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : "";
}

// ─── Interface utilization ────────────────────────────────────────────────────

// Percent of link capacity used, from one interface's counter change.
//
// Ethernet is full-duplex, so the busier direction is what counts, not rx + tx.
// Summing would show a 100 Mbit/s link with 60 Mbit/s each way as 120%. Same as
// LibreNMS/Cacti.
//
// Returns null when it cannot be computed (no previous sample, no elapsed time,
// unknown link speed), so the field is left out instead of written as 0.
export function computeUtilizationPct({ dRxBytes, dTxBytes, dtSec, speedMbps }) {
  if (!(dtSec > 0) || !(speedMbps > 0)) return null;
  const capacityBytesPerSec = (speedMbps * 1e6) / 8; // Mbit/s → bytes/s
  const bytesPerSec = Math.max(dRxBytes, dTxBytes) / dtSec; // busier direction
  return Math.min(100, (bytesPerSec / capacityBytesPerSec) * 100);
}

// History range resolution is in services/historyRange.js, since server history uses
// it too.

// Counter change that ignores a decrease. The ifHC*Octets counters only go up; a drop
// means a wrap or reboot and counts as no traffic. Takes BigInt, returns Number.
export function counterDelta(current, previous) {
  const cur = typeof current === "bigint" ? current : BigInt(current ?? 0);
  const prev = typeof previous === "bigint" ? previous : BigInt(previous ?? 0);
  return cur >= prev ? Number(cur - prev) : 0;
}

// ─── Fast UPS power watch ──────────────────────────────────────────────────────
// services/upsPowerWatch.js reads only the output source and battery status every few
// seconds and runs a full poll when this key changes, so on-battery / bypass /
// output-off alert in seconds instead of up to 60s. AVR counts as normal: it raises
// nothing, and a UPS can switch in and out of AVR many times a minute.
// `state` is an upsOutputState() string; batteryStatus is the RFC 1628 value (or null).
export function upsPowerKey(state, batteryStatus) {
  const s = state === "avr" ? "normal" : (state ?? "unknown");
  return `${s}|${batteryStatus ?? "?"}`;
}

// ─── Router / switch CPU and memory ────────────────────────────────────────────
// IF-MIB is the same on every brand; CPU and memory are not. snmpPollerService asks
// the vendor's own MIB first (picked from sysObjectID) and falls back to the standard
// HOST-RESOURCES-MIB. These turn the raw values into one percent each; null means
// "this device did not say", shown as "—" rather than 0.

// Enterprise numbers under 1.3.6.1.4.1 that have a vendor reader.
export const VENDOR = { cisco: 9, hp: 11, huawei: 2011, juniper: 2636 };

// sysObjectID "1.3.6.1.4.1.9.1.1208" → 9. null when it is not an enterprise OID.
export function enterpriseOf(sysObjectID) {
  const m = /^\.?1\.3\.6\.1\.4\.1\.(\d+)/.exec(String(sysObjectID ?? ""));
  return m ? Number(m[1]) : null;
}

const pct = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 10) / 10 : null;
};

// Rows of a walked column → the numbers in it, in index order.
const valuesOf = (col) => Object.values(col ?? {}).map(Number).filter(Number.isFinite);

// hrProcessorLoad has one row per CPU core; the device's CPU is their average.
export function averagePercent(col) {
  const v = valuesOf(col).filter((n) => n >= 0 && n <= 100);
  return v.length ? pct(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

// Huawei and Juniper report one row per board or slot, and boards without a CPU read
// 0. The busiest one is the figure that matters.
export function maxPercent(col) {
  const v = valuesOf(col).filter((n) => n >= 0 && n <= 100);
  return v.length ? pct(Math.max(...v)) : null;
}

// hrStorageRam (HOST-RESOURCES-MIB hrStorageTypes.2).
export const HR_STORAGE_RAM = "1.3.6.1.2.1.25.2.1.2";

// Memory % from hrStorageTable: the rows typed as RAM, used ÷ size. Units cancel out
// within a row, but are applied anyway so rows with different units sum correctly.
export function hrMemoryPercent({ types, units, sizes, used }) {
  let total = 0;
  let inUse = 0;
  for (const [idx, type] of Object.entries(types ?? {})) {
    if (String(type).replace(/^\./, "") !== HR_STORAGE_RAM) continue;
    const u = Number(units?.[idx]) || 1;
    const size = Number(sizes?.[idx]);
    const usedN = Number(used?.[idx]);
    if (!(size > 0) || !Number.isFinite(usedN)) continue;
    total += size * u;
    inUse += usedN * u;
  }
  return total > 0 ? pct((inUse / total) * 100) : null;
}

// CISCO-MEMORY-POOL-MIB: used and free per pool. Pool 1 is the processor pool, which
// is the one a Cisco "show memory" headline refers to; all pools when it is missing.
export function ciscoMemoryPercent(used, free) {
  const one = (u, f) => {
    const a = Number(u);
    const b = Number(f);
    return Number.isFinite(a) && Number.isFinite(b) && a + b > 0 ? pct((a / (a + b)) * 100) : null;
  };
  if (used?.["1"] != null && free?.["1"] != null) return one(used["1"], free["1"]);
  const u = valuesOf(used).reduce((a, b) => a + b, 0);
  const f = valuesOf(free).reduce((a, b) => a + b, 0);
  return one(u, f);
}

// One value that is already a percent (e.g. HP's hpSwitchCpuStat scalar).
export const percentOrNull = pct;
