// ─── PURE helpers for the SNMP router/UPS path ────────────────────────────────
//
// DELIBERATELY IMPORT-FREE — no mysql, no influx, no dotenv — so `backend/tests/`
// can exercise this logic with nothing running. Same contract as the server path's
// serverMetricUtils.js; snmpPollerService imports from here rather than keeping its
// own copies, so the behaviour under test is the behaviour in production.

// ─── Validation / normalization ───────────────────────────────────────────────

// A 400 the Express error handler surfaces to the client (it reads `err.status`).
export function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

export const numOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// numOrNull plus a range check. UPS firmware routinely reports a sentinel (-1,
// 0xFFFF, …) for a value it can't currently compute and RFC 1628 defines no
// "unknown" encoding, so an out-of-range reading is discarded rather than believed.
// Returning null means the InfluxDB field is skipped AND deviceAlerts.evalMetric
// bails (num(null) → NaN), so a sentinel can't trip a lower-is-worse rule.
export const inRange = (v, min, max) => {
  const n = numOrNull(v);
  return n == null || n < min || n > max ? null : n;
};

// Per-object bounds for the UPS-MIB reads. Where RFC 1628 states a range we use it
// verbatim; where it doesn't (voltage, temperature) we use a physical-plausibility
// limit generous enough for 3-phase gear and an unheated server room.
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
//
// Where the load is being fed FROM. This one integer is the difference between a
// protected rack and an unprotected one, and only two of its seven values mean
// everything is fine.
//
// The enum and its interpreters live here, in the pure module, rather than beside
// the OIDs in snmpClient.js: they are the reasoning, not the transport, and this is
// the file `npm test` can reach without net-snmp or a device.
export const UPS_OUTPUT_SOURCE = {
  other: 1,
  none: 2,
  normal: 3,
  bypass: 4,
  battery: 5,
  booster: 6,
  reducer: 7,
};

// Collapse the seven raw values into the states an operator would act on.
//
//   normal   mains, through the inverter — protected
//   battery  mains lost, running down the battery. You have N minutes.
// bypass load wired straight to RAW MAINS, around the inverter and battery.
//            It keeps running, so nothing looks wrong — but protection is GONE:
//            if mains drops now, everything dies instantly with zero runtime.
//            Reached by overload, overheating, an internal fault, or someone
//            throwing the maintenance bypass switch.
//   off      output disabled entirely — the load is dead.
//   avr      mains present but out of spec; the UPS is boosting/trimming it.
//            Still protected. Mains quality is degrading.
//   unknown  other(1), or anything not in the enum.
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

// True when the load is running on raw mains with NO protection behind it.
//
// This was the gap: the enum has named `bypass` since it was written, but the
// only interpreter was isOnBattery, which tests for battery(5) alone. A UPS in
// bypass therefore reported onBattery:false and read as perfectly normal — green
// tile, no alert — while the racks behind it had zero seconds of runtime. Exactly
// backwards from the risk: on-battery is loud and gives you minutes; bypass was
// silent and gives you none.
export const isOnBypass = (v) => upsOutputState(v) === "bypass";

// True when the UPS is not feeding the load at all.
export const isOutputOff = (v) => upsOutputState(v) === "off";

// Is the load protected right now?
//
// Written as "not one of the three states we KNOW are unprotected", never as "one of
// the states we know are fine". The difference is what happens to `unknown`: a UPS
// reporting other(1) or a value outside the enum has told us nothing, and turning
// that silence into an outage would page someone at 3 a.m. over a firmware quirk.
// An allow-list would also silently start reporting every future RFC value as an
// outage, which is the wrong default for a list we don't control.
export const isProtected = (v) => !["battery", "bypass", "off"].includes(upsOutputState(v));

// SNMP port: blank/omitted → 161; anything else must be a real port. Throws rather
// than silently coercing, so a typo'd port surfaces on the form instead of producing
// a device that sits Offline forever with nothing explaining why.
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

// Derive a /24 segment string from an IPv4 address ("" if unknown). THE one copy:
// agentService used to carry a byte-identical private version, so a Go-agent host and
// an SNMP-polled router wrote device_network.network_segment through two functions
// that only happened to agree. It imports this now.
export function networkSegment(ip) {
  const m = typeof ip === "string" && ip.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : "";
}

// ─── Interface utilization ────────────────────────────────────────────────────

// Percent of link capacity used, from one interface's counter delta.
//
// Ethernet is FULL-DUPLEX: rx and tx each get the full link speed, so the busier
// DIRECTION is the saturation measure — not their sum. Summing reports a 100 Mbit/s
// link carrying 60 Mbit/s each way as 120% (clamped to 100%) when neither direction
// is above 60%, which false-fires the `link_util` rule. This matches the
// LibreNMS/Cacti convention of graphing in/out separately and alerting on the worse.
// (Half-duplex would want the sum, but IF-MIB duplex state isn't collected and
// modern switched gear is full-duplex.)
//
// Returns null when it can't be computed (no baseline, no elapsed time, unknown or
// zero link speed) so the caller can omit the field rather than write a bogus 0.
export function computeUtilizationPct({ dRxBytes, dTxBytes, dtSec, speedMbps }) {
  if (!(dtSec > 0) || !(speedMbps > 0)) return null;
  const capacityBytesPerSec = (speedMbps * 1e6) / 8; // Mbit/s → bytes/s
  const bytesPerSec = Math.max(dRxBytes, dTxBytes) / dtSec; // busier direction
  return Math.min(100, (bytesPerSec / capacityBytesPerSec) * 100);
}

// NOTE: history range resolution (presets + custom windows) deliberately does NOT
// live here — it is shared with the SERVER history endpoint too, so it lives in the
// neutrally-named services/historyRange.js. This module stays SNMP-specific.

// Counter delta that discards a decrease. ifHC*Octets are monotonically increasing
// 64-bit counters; a drop means a wrap or a device reboot, which must read as "no
// traffic this interval" rather than graphing a huge negative-turned-positive spike.
// Takes BigInt (the precision-safe type Counter64 normalizes to) and returns Number.
export function counterDelta(current, previous) {
  const cur = typeof current === "bigint" ? current : BigInt(current ?? 0);
  const prev = typeof previous === "bigint" ? previous : BigInt(previous ?? 0);
  return cur >= prev ? Number(cur - prev) : 0;
}
