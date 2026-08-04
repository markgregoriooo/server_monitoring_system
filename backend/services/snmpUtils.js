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

// Derive a /24 segment string from an IPv4 address ("" if unknown) — mirrors
// agentService.networkSegment so device_network.network_segment stays consistent.
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

// ─── History range resolution (presets + custom absolute window) ──────────────
//
// Shared by the network and UPS history handlers so both offer the same ranges and
// the same custom-window rules. Pure string/date math — no Flux is executed here,
// the caller splices the returned fragment into its query.
//
// SAFETY: a Flux query is built by string concatenation, so nothing user-typed may
// reach it verbatim. Presets are a fixed whitelist. Custom bounds are parsed into
// Date objects and re-serialised with toISOString(), so what lands in the query can
// only ever be a canonical `YYYY-MM-DDTHH:mm:ss.sssZ` — the user's original text is
// discarded, not escaped. Anything unparseable is a 400, never a passthrough.

// Preset → aggregate window, each sized to land at ~150–200 points so every range
// costs the browser about the same to draw:
//   1h/20s=180  6h/2m=180  24h/10m=144  7d/1h=168  30d/4h=180
export const PRESET_WINDOW = {
  "-1h": "20s",
  "-6h": "2m",
  "-24h": "10m",
  "-7d": "1h",
  "-30d": "4h",
};
export const DEFAULT_RANGE = "-1h";

// Custom-window bounds. The floor keeps a degenerate range from asking for a
// sub-second aggregate window; the ceiling keeps one mis-typed year from scanning
// the whole bucket. A year is well past any retention this system keeps.
export const MIN_CUSTOM_SPAN_SEC = 60;
export const MAX_CUSTOM_SPAN_SEC = 366 * 86400;

const TARGET_POINTS = 175;

// Aggregate window for an arbitrary span, in Flux duration form. Chosen so a custom
// range draws at the same density as the presets rather than returning either 6
// points or 40,000.
export function windowForSpan(spanSec, targetPoints = TARGET_POINTS) {
  const s = Math.max(1, Math.round(spanSec / targetPoints));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.max(1, Math.round(s / 3600))}h`;
  return `${Math.max(1, Math.round(s / 86400))}d`;
}

// Strict date parse: only a string/number that yields a real instant is accepted.
// `new Date(undefined)` and `new Date("banana")` both give Invalid Date, and a bare
// boolean/object must not be coerced, hence the typeof guard.
function parseInstant(v, field) {
  if (typeof v !== "string" && typeof v !== "number") {
    throw badRequest(`${field} must be an ISO-8601 timestamp.`);
  }
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) throw badRequest(`${field} is not a valid timestamp.`);
  return d;
}

// Resolve a request's range into the Flux `range(...)` arguments plus the matching
// aggregate window.
//
//   resolveRange({ range: "-7d" })
//     → { rangeExpr: 'start: -7d', every: '1h', custom: false }
//   resolveRange({ start: "2026-08-01T00:00:00Z", stop: "2026-08-02T00:00:00Z" })
//     → { rangeExpr: 'start: time(v: "…"), stop: time(v: "…")', every: '8m', custom: true }
//
// `stop` may be omitted when `start` is given — that reads as "since then, up to now".
// An unknown preset falls back to the default rather than erroring, matching the old
// behaviour; a malformed CUSTOM window throws, because silently charting the wrong
// period is worse than telling the user their input was rejected.
export function resolveRange({ range, start, stop } = {}) {
  const hasCustom = start != null && start !== "";
  if (!hasCustom) {
    if (stop != null && stop !== "") {
      throw badRequest("A custom range needs `start` as well as `stop`.");
    }
    const key = String(range ?? DEFAULT_RANGE);
    const preset = PRESET_WINDOW[key] ? key : DEFAULT_RANGE;
    return { rangeExpr: `start: ${preset}`, every: PRESET_WINDOW[preset], custom: false, preset };
  }

  const startAt = parseInstant(start, "start");
  const stopAt = stop == null || stop === "" ? new Date() : parseInstant(stop, "stop");

  const spanSec = (stopAt.getTime() - startAt.getTime()) / 1000;
  if (spanSec <= 0) throw badRequest("`start` must be earlier than `stop`.");
  if (spanSec < MIN_CUSTOM_SPAN_SEC) throw badRequest("The custom range must span at least 1 minute.");
  if (spanSec > MAX_CUSTOM_SPAN_SEC) throw badRequest("The custom range cannot span more than a year.");

  // Re-serialised from Date — the user's original text never reaches the query.
  const startISO = startAt.toISOString();
  const stopISO = stopAt.toISOString();
  return {
    rangeExpr: `start: time(v: ${JSON.stringify(startISO)}), stop: time(v: ${JSON.stringify(stopISO)})`,
    every: windowForSpan(spanSec),
    custom: true,
    startISO,
    stopISO,
  };
}

// Counter delta that discards a decrease. ifHC*Octets are monotonically increasing
// 64-bit counters; a drop means a wrap or a device reboot, which must read as "no
// traffic this interval" rather than graphing a huge negative-turned-positive spike.
// Takes BigInt (the precision-safe type Counter64 normalizes to) and returns Number.
export function counterDelta(current, previous) {
  const cur = typeof current === "bigint" ? current : BigInt(current ?? 0);
  const prev = typeof previous === "bigint" ? previous : BigInt(previous ?? 0);
  return cur >= prev ? Number(cur - prev) : 0;
}
