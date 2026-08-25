// ─── History range resolution (presets + custom absolute window) ──────────────
//
// Shared by the history endpoints (`/api/servers/:id/history` today; the network and
// UPS handlers have the identical shape and should adopt it) so every page offers
// the same ranges and the same custom-window rules. A CPU spike and the traffic
// during the same incident have to be comparable over the same period.
//
// DELIBERATELY IMPORT-FREE — no mysql, no influx, no dotenv — so `backend/tests/`
// can exercise it with nothing running, the same contract as serverMetricUtils.js.
// Pure string/date math: no Flux is executed here, the caller splices the returned
// fragment into its own query.
//
// SAFETY: a Flux query is built by string concatenation, so nothing user-typed may
// reach it verbatim. Presets are a fixed whitelist. Custom bounds are parsed into
// Date objects and re-serialised with toISOString(), so what lands in the query can
// only ever be a canonical `YYYY-MM-DDTHH:mm:ss.sssZ` — the user's original text is
// discarded, not escaped. Anything unparseable is a 400, never a passthrough.

// A 400 the Express error handler surfaces to the client (it reads `err.status`).
export function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

// Preset → aggregate window, each sized to land at ~150–200 points: enough shape to
// read, few enough that a 30d query doesn't ship megabytes to the browser or make
// Influx scan and return millions of raw points.
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
// An unknown preset falls back to the default rather than erroring, preserving the
// long-standing behaviour; a malformed CUSTOM window throws, because silently
// charting the wrong period is worse than telling the user their input was rejected.
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


// ─── The envelope every history endpoint repeats ──────────────────────────────
//
// serverHistoryHandler, upsHistoryHandler and networkHistoryHandler each opened with the
// same id guard and the same resolveRange try/catch, and each closed by hand-assembling
// the same response object. The copies had already drifted: only the SERVER handler
// returned `spanSec`, which is what lets the client decide whether the x-axis needs
// DATES — so the same range choice labelled differently depending on the page.
//
// See audits/code-duplication-report-2026-08-25.md — R-08.

/**
 * Parse `:id` and resolve the range in one step.
 *
 * Answers the request itself and returns null when the input is bad, so the caller's
 * first two lines become `const p = resolveHistoryRequest(req, res); if (!p) return;`.
 *
 * A malformed CUSTOM window is a 400 — silently charting the wrong period is worse than
 * saying the input was rejected. An unknown PRESET still falls back to the default.
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
