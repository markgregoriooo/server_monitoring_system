// ─── Predictive-analytics math ───────────────────────────────────────────────
// All the statistics behind the Analytics page, with no imports, so backend/tests
// can run it without a database (analyticsService.js connects to MySQL and InfluxDB
// on import). No I/O, no config and no clock reads here; those go in
// analyticsService.js. The math is explained in predictive-analytics.md §2–§4.

// ─── Output gates ─────────────────────────────────────────────────────────────
export const MIN_POINTS = 6;      // need a real series before we trust a slope
export const STABLE_EPS = 0.0001; // %/hour below this magnitude = effectively flat
// Only show an ETA when the fit is good and the horizon is reasonable. A nearly
// flat disk has a tiny slope that gives a meaningless date (e.g. 660 days), so it
// reports "stable" instead. See §3.
export const MIN_ETA_R2 = 0.4;    // below this = "low" confidence → don't trust an ETA
export const MAX_ETA_DAYS = 365;  // a >1-year projection from a short window isn't a forecast

// ─── Small helpers ────────────────────────────────────────────────────────────
export const round1 = (v) => Math.round(v * 10) / 10;
export const round2 = (v) => Math.round(v * 100) / 100;

export const clampInt = (v, min, max, dflt) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

export const clampNum = (v, min, max, dflt) => {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

export const confidenceLabel = (r2) => {
  if (r2 == null) return "low";
  if (r2 >= 0.7) return "high";
  if (r2 >= 0.4) return "medium";
  return "low";
};

export const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

export const stddev = (a, m = mean(a)) => {
  if (a.length < 2) return 0;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

// Local hour (UTC+8) for the hour-of-day baseline. Influx times are UTC; the offset
// is passed in so the result does not depend on the server's locale.
export const TZ_OFFSET_H = 8;
export const localHour = (ms, offsetH = TZ_OFFSET_H) =>
  (new Date(ms).getUTCHours() + offsetH) % 24;

// Local day of week (0 = Sunday), offset like localHour.
export const localDay = (ms, offsetH = TZ_OFFSET_H) => {
  const d = new Date(ms);
  const shifted = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + offsetH);
  return new Date(shifted).getUTCDay();
};

export const isWeekend = (ms, offsetH = TZ_OFFSET_H) => {
  const day = localDay(ms, offsetH);
  return day === 0 || day === 6;
};

// Baseline bucket: hour of day, split into weekday and weekend (48 buckets). A
// Saturday 2 PM and a Tuesday 2 PM are very different on a campus, and pooling them
// hides real weekday spikes and flags normal Sundays.
export const BASELINE_BUCKETS = 48;
export const baselineBucket = (ms, offsetH = TZ_OFFSET_H) =>
  localHour(ms, offsetH) + (isWeekend(ms, offsetH) ? 24 : 0);

// Human label for a bucket index, for the API/UI ("Tue 14:00" style grouping).
export const bucketLabel = (idx) => ({
  hour: idx % 24,
  dayType: idx >= 24 ? "weekend" : "weekday",
});

// Window helper: pick an aggregate bucket appropriate to the lookback length.
export const everyForHours = (h) => (h <= 24 ? "15m" : h <= 72 ? "30m" : "1h");

// Wider buckets for the multi-day forecasts. A months-long window at 1h would pull
// thousands of points just to fit a line; this keeps each window at a few hundred.
export const bucketForDays = (d) => (d <= 30 ? "1h" : d <= 120 ? "6h" : "1d");

// Actual span of a series in days (first to last sample), not the requested
// lookback. They differ when retention is shorter or the device is newer.
export function spanDays(raw) {
  if (!raw || raw.length < 2) return 0;
  let min = Infinity, max = -Infinity;
  for (const p of raw) {
    if (p.t < min) min = p.t;
    if (p.t > max) max = p.t;
  }
  return Math.round(((max - min) / 86_400_000) * 10) / 10;
}

export const parseEveryMs = (e) => {
  const m = /^(\d+)([smhd])$/.exec(e);
  if (!m) return 3_600_000;
  const n = Number(m[1]);
  return n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
};

// ─── Ordinary least-squares linear regression ──────────────────────────
// points: [{ x, y }] with x = hours since the first sample. Returns slope, intercept,
// R² and MAE, or null if no line can be fitted.
export function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; }
  const xb = sx / n, yb = sy / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.x - xb) * (p.y - yb); den += (p.x - xb) ** 2; }
  if (den === 0) return null; // all x identical → no slope
  const slope = num / den;
  const intercept = yb - slope * xb;
  const { r2, mae } = score({ slope, intercept }, points);
  return { slope, intercept, r2, mae };
}

// R²/MAE of a model on a set of points (in- or out-of-sample). R² uses the mean of
// the evaluated set, per convention.
export function score(model, points) {
  const n = points.length;
  if (!n) return { r2: null, mae: null };
  const yb = points.reduce((s, p) => s + p.y, 0) / n;
  let ssRes = 0, ssTot = 0, absErr = 0;
  for (const p of points) {
    const yhat = model.slope * p.x + model.intercept;
    ssRes += (p.y - yhat) ** 2;
    ssTot += (p.y - yb) ** 2;
    absErr += Math.abs(p.y - yhat);
  }
  const r2 = ssTot === 0 ? (ssRes === 0 ? 1 : 0) : 1 - ssRes / ssTot;
  return { r2, mae: absErr / n };
}

// Chronological split — time series MUST train on the past and test on the recent
// tail (a random split leaks the future into training).
export function splitTrainTest(points, ratio = 0.8) {
  const cut = Math.floor(points.length * ratio);
  return { train: points.slice(0, cut), test: points.slice(cut) };
}

// Fit on the first 80%, score on the last 20%. The projection still uses the model
// fitted on all points; this held-out score decides whether to trust it. With too
// few points to split, the in-sample score is used.
export function validate(points, model) {
  if (points.length < 10) return { r2: model.r2, mae: model.mae };
  const { train, test } = splitTrainTest(points, 0.8);
  const tm = linearRegression(train);
  if (tm && test.length >= 2) return score(tm, test);
  return { r2: model.r2, mae: model.mae };
}

// ─── Percentiles ──────────────────────────────────────────────────────────────
// Linear-interpolated percentile (p in 0..100). Returns null for an empty set.
export function percentile(values, p) {
  const a = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  if (a.length === 1) return a[0];
  const idx = (p / 100) * (a.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

// ─── Smoothing: EWMA + Holt's linear trend ────────────────────────────────────
// Exponentially weighted moving average. alpha in (0,1]; higher follows recent
// points more closely. Used for the smoothed line on the chart.
export function ewma(values, alpha = 0.3) {
  if (!values.length) return [];
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(alpha * values[i] + (1 - alpha) * out[i - 1]);
  return out;
}

// Holt's linear method (double exponential smoothing): a level plus a trend, i.e.
// Holt-Winters without seasonality. forecast(h) projects h steps past the last point.
//
// It extends the current slope in a straight line, so only use it for horizons
// shorter than the data's cycle. On room temperature (a 24h cycle) a 12h forecast
// made at night would carry the evening drop into midday. Use forecastSeasonal for that.
export function holtLinear(values, { alpha = 0.5, beta = 0.2 } = {}) {
  const n = values.length;
  if (n < 2) return null;
  let level = values[0];
  let trend = values[1] - values[0];
  const smoothed = [level];
  for (let i = 1; i < n; i++) {
    const prevLevel = level;
    level = alpha * values[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    smoothed.push(level);
  }
  return { level, trend, smoothed, forecast: (h) => level + h * trend };
}

// ─── Daily seasonality ────────────────────────────────────────────────────────
// How far each local hour usually sits from the overall mean.

/** Local hours that must carry data before the daily shape is trusted (of 24). */
export const MIN_PROFILE_HOURS = 18;
/** Full cycles the window must span. One cycle cannot separate "daily shape" from "trend". */
export const MIN_PROFILE_CYCLES = 2;

/**
 * Mean deviation from the overall mean for each hour of the day.
 *
 * Returns { deviations: number[24] (0 where unknown), hoursCovered, cycles, usable }.
 * Hours with no data get 0, which flattens that hour instead of inventing a swing.
 */
export function hourlyProfile(raw, { offsetH = TZ_OFFSET_H } = {}) {
  const deviations = new Array(24).fill(0);
  const counts = new Array(24).fill(0);
  if (!raw || raw.length < 2) return { deviations, hoursCovered: 0, cycles: 0, usable: false };

  const overall = mean(raw.map((p) => p.y));
  const sums = new Array(24).fill(0);
  for (const p of raw) {
    const h = localHour(p.t, offsetH);
    sums[h] += p.y - overall;
    counts[h] += 1;
  }
  let hoursCovered = 0;
  for (let h = 0; h < 24; h++) {
    if (counts[h] > 0) {
      deviations[h] = sums[h] / counts[h];
      hoursCovered += 1;
    }
  }

  let min = Infinity, max = -Infinity;
  for (const p of raw) { if (p.t < min) min = p.t; if (p.t > max) max = p.t; }
  const cycles = (max - min) / 86_400_000;

  return {
    deviations,
    hoursCovered,
    cycles: Math.round(cycles * 10) / 10,
    usable: hoursCovered >= MIN_PROFILE_HOURS && cycles >= MIN_PROFILE_CYCLES,
  };
}

// ─── Is this window good enough to forecast from? ─────────────────────────────
// A half-empty window gives a confident but wrong forecast, e.g. a sensor that only
// ran during office hours has never seen a morning. Better to say so.

/** Of 24 local hours, how many must carry at least one sample. */
export const MIN_COVERAGE_HOURS = 18;
/** Fraction of the expected buckets that must actually be present. */
export const MIN_COVERAGE_RATIO = 0.6;
/** A hole longer than this means a whole part of the day is simply unobserved. */
export const MAX_GAP_HOURS = 6;
/** Days the window must span before a daily shape can be separated from a trend. */
export const MIN_SPAN_DAYS = 2;

/**
 * Judge whether a series can support a forecast, and if not, why.
 *
 * Coverage is measured against the span the data actually covers, not the
 * requested lookback, so a new install is not flagged for missing days.
 *
 * @returns { ok, reason, message, points, spanDays, hoursCovered, coverage, largestGapHours }
 */
export function assessSeries(raw, { stepMs, offsetH = TZ_OFFSET_H } = {}) {
  const out = {
    ok: false, reason: "no_data", message: "No readings stored yet.",
    points: 0, spanDays: 0, hoursCovered: 0, coverage: 0, largestGapHours: 0,
  };
  if (!raw || raw.length < MIN_POINTS) {
    out.points = raw?.length ?? 0;
    out.message = `Only ${out.points} reading(s) stored — needs ${MIN_POINTS}.`;
    return out;
  }

  const s = [...raw].sort((a, b) => a.t - b.t);
  out.points = s.length;
  const spanMs = s[s.length - 1].t - s[0].t;
  out.spanDays = Math.round((spanMs / 86_400_000) * 10) / 10;

  const hours = new Set(s.map((p) => localHour(p.t, offsetH)));
  out.hoursCovered = hours.size;

  // Largest hole between consecutive readings.
  let largestGap = 0;
  for (let i = 1; i < s.length; i++) largestGap = Math.max(largestGap, s[i].t - s[i - 1].t);
  out.largestGapHours = Math.round((largestGap / 3_600_000) * 10) / 10;

  // How much of the spanned window actually has data.
  if (stepMs > 0 && spanMs > 0) {
    out.coverage = Math.min(1, Math.round((s.length / (spanMs / stepMs + 1)) * 100) / 100);
  }

  // Ordered worst-first, so the message names the thing most worth fixing.
  if (out.spanDays < MIN_SPAN_DAYS) {
    out.reason = "too_short";
    out.message = `Only ${out.spanDays} day(s) of history — needs ${MIN_SPAN_DAYS}.`;
    return out;
  }
  if (out.hoursCovered < MIN_COVERAGE_HOURS) {
    out.reason = "hours_missing";
    out.message = `Only ${out.hoursCovered} of 24 hours of the day recorded.`;
    return out;
  }
  if (out.largestGapHours > MAX_GAP_HOURS) {
    out.reason = "gaps";
    out.message = `${out.largestGapHours}-hour gap in the readings.`;
    return out;
  }
  if (out.coverage < MIN_COVERAGE_RATIO) {
    out.reason = "sparse";
    out.message = `Only ${Math.round(out.coverage * 100)}% of expected readings present.`;
    return out;
  }

  out.ok = true;
  out.reason = "ok";
  out.message = "";
  return out;
}

/** How long the anchor correction takes to fade, in ms. See forecastSeasonal. */
export const ANCHOR_FADE_MS = 3 * 3_600_000;

/**
 * Forecast a cyclic series: Holt on the values with the daily shape removed, then
 * add the shape back (additive Holt-Winters).
 *
 * 1. Fitted on the raw values, not the smoothed line, so the forecast does not
 *    start from a lagged level.
 * 2. Shifted to start at the last actual reading; the shift fades out linearly
 *    over ANCHOR_FADE_MS, so one noisy reading does not bias the whole horizon.
 *
 * Falls back to a straight-line projection when the window cannot support a daily
 * shape (too few hours or fewer than MIN_PROFILE_CYCLES days); `seasonal: false`
 * tells the caller.
 *
 * @param raw [{ t: epochMs, y }]
 * @returns { points: [{t, value}], trendPerHour, seasonal, profile, anchorOffset } | null
 */
export function forecastSeasonal(raw, { horizonMs, stepMs, offsetH = TZ_OFFSET_H, alpha, beta } = {}) {
  if (!raw || raw.length < MIN_POINTS || !(horizonMs > 0) || !(stepMs > 0)) return null;
  const s = [...raw].sort((a, b) => a.t - b.t);
  const lastT = s[s.length - 1].t;
  const lastY = s[s.length - 1].y;

  const profile = hourlyProfile(s, { offsetH });
  const seasonal = profile.usable;
  const seasonalAt = (ms) => (seasonal ? profile.deviations[localHour(ms, offsetH)] : 0);

  // Strip the daily shape so Holt sees the underlying drift instead of mistaking the
  // evening's downslope for a permanent trend.
  const deseasonalised = s.map((p) => p.y - seasonalAt(p.t));
  const holt = holtLinear(deseasonalised, { ...(alpha != null ? { alpha } : {}), ...(beta != null ? { beta } : {}) });
  if (!holt) return null;

  // The gap between the model and reality at the join.
  const anchorOffset = lastY - (holt.level + seasonalAt(lastT));

  const steps = Math.max(1, Math.round(horizonMs / stepMs));
  const points = [];
  for (let k = 1; k <= steps; k++) {
    const t = lastT + k * stepMs;
    const fade = Math.max(0, 1 - (k * stepMs) / ANCHOR_FADE_MS);
    points.push({ t, value: holt.forecast(k) + seasonalAt(t) + anchorOffset * fade });
  }

  return {
    points,
    trendPerHour: (holt.trend * 3_600_000) / stepMs,
    seasonal,
    profile,
    anchorOffset,
  };
}

// ─── Advisory copy ────────────────────────────────────────────────────────────
// What to do when analytics flags a metric, keyed by alert_rules metric name.
export const METRIC_ACTION = {
  cpu: "upgrade the CPU, rebalance the workload, or investigate runaway processes",
  mem: "upgrade the RAM or investigate memory-heavy processes",
  disk: "free up space or expand the disk/volume",
  temperature: "improve server-room cooling or check the air conditioning",
  gas: "ventilate the room and check for a smoke or gas source",
  humidity: "review dehumidification / HVAC in the server room",
  net_in: "upgrade the uplink bandwidth or investigate heavy talkers",
  net_out: "upgrade the uplink bandwidth or investigate heavy talkers",
  router_cpu: "check for runaway routing/NAT load or a traffic spike on the router",
  router_mem: "restart or upgrade the router if memory keeps climbing (possible leak)",
  router_clients: "review capacity for the number of connected devices",
};
export const actionFor = (metric) => METRIC_ACTION[metric] ?? "review this server's capacity";
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Disk-specific advice from the ETA urgency (mirrors the page's red<7 / orange<30 bands).
export function diskAdvice(name, status, etaDays, full) {
  if (status === "full")
    return { level: "critical", message: `${name}: disk is at capacity (~${full}%). ${cap(actionFor("disk"))} immediately.` };
  if (status !== "filling" || etaDays == null) return null;
  const e = etaDays < 1 ? "less than a day" : `~${etaDays} day${etaDays >= 2 ? "s" : ""}`;
  if (etaDays < 7)
    return { level: "critical", message: `${name}: disk projected to reach ${full}% in ${e}. Act now — ${actionFor("disk")}.` };
  if (etaDays < 30)
    return { level: "warning", message: `${name}: disk projected to reach ${full}% in ${e}. Plan ahead — schedule cleanup or add storage.` };
  return null;
}

// ─── Projections ──────────────────────────────────────────────────────────────
// Regress a series and solve for when it reaches `full`. entry = { deviceId, name,
// raw: [{ t: epochMs, y }] }. Used for disk (per volume).
export function forecastSeries(entry, full) {
  const raw = [...entry.raw].sort((a, b) => a.t - b.t);
  const current = raw.length ? raw[raw.length - 1].y : null;
  const base = {
    deviceId: entry.deviceId,
    name: entry.name,
    currentPercent: current == null ? null : round1(current),
    slopePerDay: null,
    etaDays: null,
    full,
    fitR2: null,
    mae: null,
    confidence: "low",
    sampleCount: raw.length,
    status: "insufficient_data",
    advice: null,
  };
  if (raw.length < MIN_POINTS) return base;

  const t0 = raw[0].t;
  const points = raw.map((p) => ({ x: (p.t - t0) / 3_600_000, y: p.y }));
  const model = linearRegression(points);
  if (!model) return base;

  const { r2, mae } = validate(points, model);
  const lastX = points[points.length - 1].x;
  const slopePerDay = model.slope * 24;

  let etaDays = null;
  let status = "stable";
  if (model.slope > STABLE_EPS) {
    if (current >= full) {
      etaDays = 0;
      status = "full"; // measured fact, not a forecast — always trustworthy
    } else {
      const xFull = (full - model.intercept) / model.slope;
      const projectedDays = Math.max(0, (xFull - lastX) / 24);
      const trustworthy = r2 != null && r2 >= MIN_ETA_R2;
      if (trustworthy && projectedDays <= MAX_ETA_DAYS) {
        etaDays = projectedDays;
        status = "filling";
      } else {
        // Slope is technically positive but the fit is low-confidence or the horizon is
        // absurdly far — not meaningfully filling. Report "Stable" instead of a bogus date.
        status = "stable";
      }
    }
  } else if (model.slope < -STABLE_EPS) {
    status = "falling";
  }

  const etaRounded = etaDays == null ? null : round1(etaDays);
  return {
    ...base,
    slopePerDay: round2(slopePerDay),
    etaDays: etaRounded,
    fitR2: r2 == null ? null : round2(r2),
    mae: mae == null ? null : round2(mae),
    confidence: confidenceLabel(r2),
    status,
    advice: diskAdvice(entry.name, status, etaRounded, full),
  };
}

// Linear projection to a bound. "down" = falling to a floor (UPS runtime), "up" =
// rising to a ceiling (link utilization). Same gates as forecastSeries(), so a
// noisy or flat series reports "stable" instead of a date.
export function projectToBound(raw, { bound, direction }) {
  const sorted = [...raw].sort((a, b) => a.t - b.t);
  const current = sorted.length ? sorted[sorted.length - 1].y : null;
  const out = {
    current: current == null ? null : round1(current),
    slopePerDay: null, etaDays: null, fitR2: null, mae: null,
    confidence: "low", sampleCount: sorted.length, status: "insufficient_data",
  };
  if (sorted.length < MIN_POINTS) return out;

  const t0 = sorted[0].t;
  const points = sorted.map((p) => ({ x: (p.t - t0) / 3_600_000, y: p.y }));
  const model = linearRegression(points);
  if (!model) return out;

  const { r2, mae } = validate(points, model);
  out.slopePerDay = round2(model.slope * 24);
  out.fitR2 = r2 == null ? null : round2(r2);
  out.mae = mae == null ? null : round2(mae);
  out.confidence = confidenceLabel(r2);

  const lastX = points[points.length - 1].x;
  const trustworthy = r2 != null && r2 >= MIN_ETA_R2;
  const projectDays = () => Math.max(0, ((bound - model.intercept) / model.slope - lastX) / 24);

  if (direction === "down") {
    if (current <= bound) { out.status = "reached"; out.etaDays = 0; }
    else if (model.slope < -STABLE_EPS) {
      const days = projectDays();
      if (trustworthy && days <= MAX_ETA_DAYS) { out.status = "declining"; out.etaDays = round1(days); }
      else out.status = "stable";
    } else out.status = "stable";
  } else {
    if (current >= bound) { out.status = "reached"; out.etaDays = 0; }
    else if (model.slope > STABLE_EPS) {
      const days = projectDays();
      if (trustworthy && days <= MAX_ETA_DAYS) { out.status = "rising"; out.etaDays = round1(days); }
      else out.status = "stable";
    } else out.status = "stable";
  }
  return out;
}

// The volume that will fill first. Threshold alerts look at the fullest volume
// now; a forecast cares about the one filling fastest. Falls back to the fullest
// when nothing has a reliable ETA.
export function worstVolumeForecast(forecasts) {
  if (!forecasts.length) return null;
  const withEta = forecasts.filter((f) => f.etaDays != null);
  if (withEta.length) {
    return withEta.reduce((worst, f) => (f.etaDays < worst.etaDays ? f : worst));
  }
  return forecasts.reduce((worst, f) =>
    (f.currentPercent ?? -1) > (worst.currentPercent ?? -1) ? f : worst,
  );
}

// ─── Backtesting ──────────────────────────────────────────────────────────────
// R² and MAE show how well a line fits history, not whether forecasts came true.
// Rolling-origin validation measures that:
//
//   for several points in the past ("origins"):
//     fit using only the data available at that origin
//     predict the value `horizon` ahead
//     compare with what actually happened
//
// It works from existing history instead of waiting weeks for live predictions.
// It measures value error at the horizon ("we said 71%, it was 73%"), because ETA
// error is undefined until a disk actually fills.
export function backtestSeries(raw, { horizonMs, folds = 5, minTrain = MIN_POINTS * 2 } = {}) {
  const out = { folds: 0, mae: null, bias: null, worst: null, samples: [] };
  const s = [...raw].sort((a, b) => a.t - b.t);
  if (s.length < minTrain + 2 || !horizonMs) return out;

  // A prediction is only checkable if real data exists `horizon` beyond its origin, so
  // origins run from "just enough training data" to "one horizon before the end".
  const earliest = s[minTrain - 1].t;
  const latest = s[s.length - 1].t - horizonMs;
  if (latest <= earliest) return out; // window too short to verify even one prediction

  // Match an actual reading to the target time within half a sampling interval, so a
  // gap in the data is skipped rather than silently compared against the wrong moment.
  const gaps = [];
  for (let i = 1; i < s.length; i++) gaps.push(s[i].t - s[i - 1].t);
  gaps.sort((a, b) => a - b);
  const typicalGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 3_600_000;
  const tolerance = Math.max(typicalGap, horizonMs * 0.02);

  const n = Math.max(1, Math.floor(folds));
  const errors = [];
  for (let k = 0; k < n; k++) {
    const originT = n === 1 ? latest : earliest + ((latest - earliest) * k) / (n - 1);
    const train = s.filter((p) => p.t <= originT);
    if (train.length < minTrain) continue;

    const t0 = train[0].t;
    const model = linearRegression(train.map((p) => ({ x: (p.t - t0) / 3_600_000, y: p.y })));
    if (!model) continue;

    const targetT = originT + horizonMs;
    let actual = null;
    for (const p of s) {
      if (Math.abs(p.t - targetT) <= tolerance && (!actual || Math.abs(p.t - targetT) < Math.abs(actual.t - targetT))) {
        actual = p;
      }
    }
    if (!actual) continue;

    const predicted = model.slope * ((targetT - t0) / 3_600_000) + model.intercept;
    const error = predicted - actual.y; // signed: positive = we over-predicted
    errors.push(error);
    out.samples.push({
      originT, targetT,
      predicted: round2(predicted),
      actual: round2(actual.y),
      error: round2(error),
    });
  }

  if (!errors.length) return out;
  out.folds = errors.length;
  out.mae = round2(errors.reduce((a, e) => a + Math.abs(e), 0) / errors.length);
  // Signed mean: separates "noisy but centred" from "systematically optimistic", which is
  // the more dangerous failure for a capacity forecast.
  out.bias = round2(errors.reduce((a, e) => a + e, 0) / errors.length);
  out.worst = round2(Math.max(...errors.map(Math.abs)));
  return out;
}

// Round tick values inside [min, max] (1/2/5 x a power of ten). [] when the span is zero.
export function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const raw = (max - min) / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  // Thresholds are the midpoints between 1/2/5/10, not the values themselves. Snapping
  // "up" at each boundary (norm 2.2 → 5) overshoots badly and leaves one tick on the axis.
  const step = (norm <= 1.5 ? 1 : norm <= 3 ? 2 : norm <= 7 ? 5 : 10) * mag;
  // Adding a float step repeatedly drifts (0.4 + 0.2 = 0.6000000000000001), so round
  // each tick to the number of decimals the step has.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    out.push(Number(v.toFixed(decimals)));
  }
  return out;
}

// Sort comparator: soonest ETA first, "no ETA" (stable/falling/insufficient) last.
export const byEtaAsc = (a, b) => {
  if (a.etaDays == null && b.etaDays == null) return 0;
  if (a.etaDays == null) return 1;
  if (b.etaDays == null) return -1;
  return a.etaDays - b.etaDays;
};
