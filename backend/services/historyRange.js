// ─── History range (presets + custom window) ──────────────
// Shared by the history endpoints so every page offers the same ranges. No imports,
// so it is unit-tested; it only returns a Flux fragment for the caller's query.
//
// Nothing typed by a user reaches the query: presets are a fixed list, and custom
// bounds are parsed into Dates and written back with toISOString(). Anything that
// does not parse is a 400.

// A 400 the Express error handler surfaces to the client (it reads `err.status`).
export function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

// Preset → aggregate window, each giving about 150–200 points:
//   1h/20s=180  6h/2m=180  24h/10m=144  7d/1h=168  30d/4h=180
export const PRESET_WINDOW = {
  "-1h": "20s",
  "-6h": "2m",
  "-24h": "10m",
  "-7d": "1h",
  "-30d": "4h",
};
export const DEFAULT_RANGE = "-1h";

// Limits on a custom window: at least a minimum span (no sub-second windows) and at
// most a year (no scanning the whole bucket by mistake).
export const MIN_CUSTOM_SPAN_SEC = 60;
export const MAX_CUSTOM_SPAN_SEC = 366 * 86400;

const TARGET_POINTS = 175;

// Aggregate window for any span, so a custom range has the same point density as
// the presets.
export function windowForSpan(spanSec, targetPoints = TARGET_POINTS) {
  const s = Math.max(1, Math.round(spanSec / targetPoints));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.max(1, Math.round(s / 3600))}h`;
  return `${Math.max(1, Math.round(s / 86400))}d`;
}

// Strict date parse: only a string or number that gives a real date is accepted.
function parseInstant(v, field) {
  if (typeof v !== "string" && typeof v !== "number") {
    throw badRequest(`${field} must be an ISO-8601 timestamp.`);
  }
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) throw badRequest(`${field} is not a valid timestamp.`);
  return d;
}

// Turn a request's range into the Flux `range(...)` arguments and the aggregate window.
//
//   resolveRange({ range: "-7d" })
//     → { rangeExpr: 'start: -7d', every: '1h', custom: false }
//   resolveRange({ start: "2026-08-01T00:00:00Z", stop: "2026-08-02T00:00:00Z" })
//     → { rangeExpr: 'start: time(v: "…"), stop: time(v: "…")', every: '8m', custom: true }
//
// `stop` may be left out (means "until now"). An unknown preset falls back to the
// default; a malformed custom window throws.
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
    spanSec,
  };
}


// ─── Shared request/response handling for history endpoints ──────────────────────────────
// The server, UPS and network history handlers all repeated the id check, range
// parsing and response object (and had drifted apart).
// See audits/code-duplication-report-2026-08-25.md (R-08).

/**
 * Parse `:id` and the range in one step. On bad input it sends the error response
 * and returns null, so the caller does `if (!p) return;`. A malformed custom window
 * is a 400; an unknown preset falls back to the default.
 */
export function resolveHistoryRequest(req, res, label = "device") {
  const deviceId = parseInt(req.params.id, 10);
  if (!Number.isInteger(deviceId)) {
    res.status(400).json({ error: `Invalid ${label} id.` });
    return null;
  }
  try {
    return { deviceId, resolved: resolveRange(req.query) };
  } catch (err) {
    res.status(err.status ?? 400).json({ error: err.message });
    return null;
  }
}

/**
 * Echo what was actually served, so the client can label its axis without re-deriving
 * any of it. `extra` carries the per-endpoint payload (`history`, `icmp`, …).
 */
export function historyEnvelope(resolved, extra) {
  return {
    range: resolved.custom ? "custom" : resolved.preset,
    start: resolved.startISO ?? null,
    stop: resolved.stopISO ?? null,
    spanSec: resolved.spanSec ?? null,
    every: resolved.every,
    ...extra,
  };
}

export default {
  resolveRange,
  resolveHistoryRequest,
  historyEnvelope,
  windowForSpan,
  badRequest,
  PRESET_WINDOW,
  DEFAULT_RANGE,
};
