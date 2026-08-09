// ─── Predictive-analytics math (PURE) ─────────────────────────────────────────
//
// Every statistical function behind the Analytics feature, with **no imports**.
// That is deliberate and load-bearing: `analyticsService.js` opens MySQL and
// InfluxDB connections at import time, so anything living there is untestable
// without a running stack. Keeping the math here lets `backend/tests/` exercise
// it under plain `node --test` with no DB, no .env and no network — the same
// reason `serverMetricUtils.js` and `historyRange.js` are import-free.
//
// Rule for this file: no I/O, no config reads, no clock reads. Everything takes
// its inputs as arguments and returns a value. If you need a query or `Date.now()`,
// it belongs in analyticsService.js.
//
// The math is documented in predictive-analytics.md §2–§4.

// ─── Output gates ─────────────────────────────────────────────────────────────
export const MIN_POINTS = 6;      // need a real series before we trust a slope
export const STABLE_EPS = 0.0001; // %/hour below this magnitude = effectively flat
// An ETA is surfaced only when the fit is trustworthy AND the horizon is sane. A
// near-flat/noisy disk has a tiny positive slope that is real arithmetic but a
// meaningless forecast (e.g. ~660 days) — report "stable" instead. See §3.
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

// Server-room local hour (UTC+8) — so the per-hour-of-day baseline labels "2 PM" the
// way the operators read the clock. Influx timestamps are UTC; we offset for bucketing
// only. Passed the offset explicitly so this stays independent of server locale.
export const TZ_OFFSET_H = 8;
export const localHour = (ms, offsetH = TZ_OFFSET_H) =>
  (new Date(ms).getUTCHours() + offsetH) % 24;

// Local day-of-week (0 = Sunday), offset the same way as localHour — a UTC timestamp late
// on a Sunday evening is already Monday in Naga, and bucketing it as Sunday would file
// Monday's traffic under the weekend.
export const localDay = (ms, offsetH = TZ_OFFSET_H) => {
  const d = new Date(ms);
  const shifted = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + offsetH);
  return new Date(shifted).getUTCDay();
};

export const isWeekend = (ms, offsetH = TZ_OFFSET_H) => {
  const day = localDay(ms, offsetH);
  return day === 0 || day === 6;
};

// Baseline bucket index. The detector compares a reading against "normal for this hour",
// but on a campus a Saturday 2 PM and a Tuesday 2 PM are nothing alike: pooling all seven
// days pulls the mean down and inflates the deviation, which BLINDS the detector on
// weekdays (a real spike falls inside a σ widened by quiet weekends) and can flag a
// perfectly normal Sunday as anomalous. Splitting day-type doubles the buckets to 48 and
// compares like with like.
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

// Same idea for the multi-DAY capacity forecasts. A battery-degradation window is
// measured in months, and pulling it at 1h buckets would drag ~4300 points per device
// into Node to fit a straight line through — hourly resolution tells you nothing about a
// trend that unfolds over a year. Widening the bucket keeps every window in the same
// few-hundred-points band, which is all a regression needs.
export const bucketForDays = (d) => (d <= 30 ? "1h" : d <= 120 ? "6h" : "1d");

// Actual span of a series in days (first → last sample), NOT the requested lookback.
// The two differ whenever InfluxDB retention is shorter than the window asked for, or
// the device simply hasn't been reporting that long — so this is what tells an operator
// whether a "180-day" forecast really saw 180 days.
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

// ─── Ordinary least-squares simple linear regression ──────────────────────────
// points: [{ x, y }]; we use x = hours-since-first-sample. Returns slope/intercept
// plus in-sample R²/MAE, or null if a line cannot be fit (too few / degenerate).
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

// Fit on the past 80%, score on the recent 20%. The caller keeps the all-points model
// for the projection itself (more data = steadier estimate); this held-out score is
// what decides whether to trust it. Too few points to split → in-sample score.
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
// Exponentially weighted moving average. alpha∈(0,1]; higher = more responsive to
// recent points. Statistics, not ML — used for the smoothed trend line.
export function ewma(values, alpha = 0.3) {
  if (!values.length) return [];
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(alpha * values[i] + (1 - alpha) * out[i - 1]);
  return out;
}

// Holt's linear method (double exponential smoothing): tracks a level + a trend — the
// NON-seasonal case of Holt-Winters. Daily seasonality is captured separately by the
// per-hour-of-day baseline (anomaly detection), so a linear trend is the right
// short-horizon projector here. forecast(h) extrapolates h steps past the last point.
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

// ─── Advisory copy ────────────────────────────────────────────────────────────
// Plain-language remediation per metric — the "what to do" once analytics flags a
// concern. Keyed by the alert_rules metric vocabulary.
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
// raw: [{ t: epochMs, y }] }. Used for disk (per volume) — the flagship forecast.
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

// Linear projection of a series to a bound. direction "down" = value falling to a floor
// (UPS runtime); "up" = value rising to a ceiling (link utilization). Mirrors
// forecastSeries() gating (R² ≥ MIN_ETA_R2, horizon ≤ MAX_ETA_DAYS) so a noisy/flat
// series reports "stable" rather than a bogus date.
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

// Pick the volume a server will run out of FIRST. Note this is not the same question
// agentService.checkThresholds asks — it alerts on the fullest volume *right now*, while a
// forecast cares about the soonest to fill. A 40%-used volume climbing 5%/day beats a
// static 88% one. Fall back to the fullest when nothing has a trustworthy ETA, which is
// also what makes the two agree on a quiet system.
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

// Sort comparator: soonest ETA first, "no ETA" (stable/falling/insufficient) last.
export const byEtaAsc = (a, b) => {
  if (a.etaDays == null && b.etaDays == null) return 0;
  if (a.etaDays == null) return 1;
  if (b.etaDays == null) return -1;
  return a.etaDays - b.etaDays;
};
