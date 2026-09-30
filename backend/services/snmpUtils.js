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
