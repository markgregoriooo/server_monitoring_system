import db from "../config/mysql.js";
import { queryClient, bucket } from "../config/influx.js";
import alertRulesService from "./alertRulesService.js";

// Predictive analytics engine (Phase 1). Pure-JS statistics + InfluxDB reads — no
// Python service. Two capabilities now: disk-full ETA (supervised linear
// regression, validated train/test) and alert analytics (over the real `alerts`
// table). See predictive-analytics.md for the math and the wider roadmap.

// ─── Math: ordinary least-squares simple linear regression ────────────────────
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

// ─── small helpers ────────────────────────────────────────────────────────────
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const clampInt = (v, min, max, dflt) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};
const clampNum = (v, min, max, dflt) => {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};
const confidenceLabel = (r2) => {
  if (r2 == null) return "low";
  if (r2 >= 0.7) return "high";
  if (r2 >= 0.4) return "medium";
  return "low";
};

// ─── Advisory copy ────────────────────────────────────────────────────────────
// Plain-language remediation per metric — the "what to do" once analytics flags a
// concern. Keyed by the alert_rules metric vocabulary; network/UPS entries are ready
// for when those branches merge (§8). Composed into messages by the advice helpers.
const METRIC_ACTION = {
  cpu: "upgrade the CPU, rebalance the workload, or investigate runaway processes",
  mem: "upgrade the RAM or investigate memory-heavy processes",
  disk: "free up space or expand the disk/volume",
  temperature: "improve server-room cooling or check the air conditioning",
  gas: "ventilate the room and check for a smoke or gas source",
  humidity: "review dehumidification / HVAC in the server room",
  net_in: "upgrade the uplink bandwidth or investigate heavy talkers",
  net_out: "upgrade the uplink bandwidth or investigate heavy talkers",
};
const actionFor = (metric) => METRIC_ACTION[metric] ?? "review this server's capacity";
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Disk-specific advice from the ETA urgency (mirrors the page's red<7 / orange<30 bands).
function diskAdvice(name, status, etaDays, full) {
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

// ─── Disk-full ETA forecast ───────────────────────────────────────────────────
const MIN_POINTS = 6;       // need a real series before we trust a slope
const STABLE_EPS = 0.0001;  // %/hour below this magnitude = effectively flat
// ETA output gate (predictive-analytics.md §3): only surface a date when the fit is
// trustworthy AND the horizon is sane. A near-flat/noisy disk has a tiny positive slope
// that is real arithmetic but a meaningless forecast (e.g. ~660 days) — show "Stable".
const MIN_ETA_R2 = 0.4;     // below this = "low" confidence → don't trust an ETA
const MAX_ETA_DAYS = 365;   // a >1-year projection from a short window isn't a real forecast
// A device whose newest sample is older than this is offline / decommissioned — or a
// duplicate "ghost" enrollment an unstable agent MAC left behind in InfluxDB — so it is
// excluded from the all-servers forecast (you can't forecast a server that stopped
// reporting). An explicit single-device request is always shown regardless.
const ACTIVE_WITHIN_MS = 24 * 60 * 60 * 1000;

// Pull hourly-averaged disk_percent per server. Window + device id are whitelisted
// (clamped int / Number) before they touch Flux — no injection surface, mirroring
// serverHistoryHandler.js.
async function fetchDiskSeries(lookbackDays, deviceId) {
  const days = clampInt(lookbackDays, 1, 90, 14);
  const idFilter =
    deviceId != null
      ? `|> filter(fn: (r) => r.device_id == "${Number(deviceId)}")`
      : "";
  const flux = `
    from(bucket: "${bucket}")
      |> range(start: -${days}d)
      |> filter(fn: (r) => r._measurement == "server_metrics")
      |> filter(fn: (r) => r._field == "disk_percent")
      ${idFilter}
      |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)
      |> keep(columns: ["_time", "_value", "device_id", "device_name"])
  `;
  const rows = await queryClient.collectRows(flux);

  const byDevice = new Map();
  for (const r of rows) {
    if (r._value == null) continue;
    const key = r.device_id;
    if (!byDevice.has(key)) {
      byDevice.set(key, {
        deviceId: Number(key),
        name: r.device_name ?? `Server ${key}`,
        raw: [],
      });
    }
    byDevice.get(key).raw.push({ t: Date.parse(r._time), y: Number(r._value) });
  }
  return byDevice;
}

function forecastSeries(entry, full) {
  const raw = entry.raw.sort((a, b) => a.t - b.t);
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

  // Out-of-sample validation: fit on the past 80%, score on the recent 20%. The
  // ETA itself uses the all-points model (more data = steadier estimate); the
  // held-out score is what tells us whether to trust it.
  let r2 = model.r2, mae = model.mae;
  if (points.length >= 10) {
    const { train, test } = splitTrainTest(points, 0.8);
    const tm = linearRegression(train);
    if (tm && test.length >= 2) ({ r2, mae } = score(tm, test));
  }

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

// Disk-full ETA for every server with data (or one, if deviceId given). Soonest
// ETA first; "no ETA" (stable/falling/insufficient) sinks to the bottom.
async function forecastDiskFull({ deviceId = null, lookbackDays = 14, full = 100 } = {}) {
  const fullPct = clampNum(full, 50, 100, 100);
  const byDevice = await fetchDiskSeries(lookbackDays, deviceId);
  const cutoff = Date.now() - ACTIVE_WITHIN_MS;
  const results = [];
  for (const entry of byDevice.values()) {
    // When listing ALL servers, drop dead/superseded enrollments: a series whose newest
    // sample is stale is an offline or decommissioned device — and exactly the duplicate
    // "ghost" an unstable agent MAC leaves behind in InfluxDB. A specific deviceId request
    // is always shown.
    if (deviceId == null) {
      const newest = entry.raw.reduce((m, p) => (p.t > m ? p.t : m), 0);
      if (newest < cutoff) continue;
    }
    results.push(forecastSeries(entry, fullPct));
  }
  results.sort((a, b) => {
    if (a.etaDays == null && b.etaDays == null) return 0;
    if (a.etaDays == null) return 1;
    if (b.etaDays == null) return -1;
    return a.etaDays - b.etaDays;
  });
  return results;
}

// ─── Alert analytics (over the real MySQL `alerts` table) ─────────────────────
// `days` is clamped to a safe integer, so inlining it in the WHERE is injection-safe.
async function alertSummary(days = 30) {
  const d = clampInt(days, 1, 365, 30);
  const since = `created_at >= NOW() - INTERVAL ${d} DAY`;

  const [[totals]] = await db.query(
    `SELECT COUNT(*) AS total,
            SUM(status <> 'resolved') AS open_count,
            AVG(CASE WHEN status = 'resolved' AND resolved_at IS NOT NULL
                     THEN TIMESTAMPDIFF(SECOND, created_at, resolved_at) END) AS avg_resolve_sec
       FROM alerts WHERE ${since}`,
  );
  const [bySeverity] = await db.query(
    `SELECT severity, COUNT(*) AS c FROM alerts WHERE ${since} GROUP BY severity`,
  );
  const [byDay] = await db.query(
    `SELECT DATE(created_at) AS day, COUNT(*) AS c
       FROM alerts WHERE ${since} GROUP BY DATE(created_at) ORDER BY day`,
  );
  const [topDevices] = await db.query(
    `SELECT a.device_id AS deviceId,
            COALESCE(d.device_name, 'Room / environment') AS name,
            COUNT(*) AS c
       FROM alerts a LEFT JOIN devices d ON d.device_id = a.device_id
      WHERE a.${since}
      GROUP BY a.device_id, name ORDER BY c DESC LIMIT 5`,
  );
  const [topTypes] = await db.query(
    `SELECT type, COUNT(*) AS c FROM alerts WHERE ${since} GROUP BY type ORDER BY c DESC LIMIT 5`,
  );

  const dayStr = (v) =>
    v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

  return {
    days: d,
    total: Number(totals?.total ?? 0),
    open: Number(totals?.open_count ?? 0),
    mttrMinutes:
      totals?.avg_resolve_sec == null
        ? null
        : Math.round(Number(totals.avg_resolve_sec) / 60),
    bySeverity: bySeverity.map((r) => ({ severity: r.severity, count: Number(r.c) })),
    byDay: byDay.map((r) => ({ day: dayStr(r.day), count: Number(r.c) })),
    topDevices: topDevices.map((r) => ({
      deviceId: r.deviceId,
      name: r.name,
      count: Number(r.c),
    })),
    topTypes: topTypes.map((r) => ({ type: r.type, count: Number(r.c) })),
  };
}

// ─── Metric registry (shared by Phases 2–4) ───────────────────────────────────
// One vocabulary, same as alert_rules.metric_name, mapped to its InfluxDB source so
// server + environment metrics flow through one code path. `gas` = the worse of the two
// MQ-2 sensors, matching sensorHandler.js (max(mq2_1_ppm, mq2_2_ppm)). `bounded` caps a
// percentage metric at 100 for threshold suggestions; absent = unbounded (°C / ppm).
const METRICS = {
  cpu:  { source: "server", field: "cpu_percent",  unit: "%",   label: "CPU",         bounded: 100 },
  mem:  { source: "server", field: "mem_percent",  unit: "%",   label: "Memory",      bounded: 100 },
  disk: { source: "server", field: "disk_percent", unit: "%",   label: "Disk",        bounded: 100 },
  temperature: { source: "env", field: "temperature", unit: "°C", label: "Temperature" },
  humidity:    { source: "env", field: "humidity",    unit: "%",  label: "Humidity"   },
  gas:         { source: "env", field: "__gas__",     unit: "ppm", label: "Gas"       },
  // Router/MikroTik device-level (router_metrics — MikroTik fills CPU/mem/clients the SNMP
  // path leaves null). recommend:false keeps them out of the server/env threshold
  // recommendations, but they still get Trend + Anomaly via the generic endpoints.
  router_cpu:     { source: "router", field: "cpu_percent",       unit: "%", label: "MikroTik CPU",     bounded: 100, recommend: false },
  router_mem:     { source: "router", field: "mem_percent",       unit: "%", label: "MikroTik Memory",  bounded: 100, recommend: false },
  router_clients: { source: "router", field: "connected_clients", unit: "",  label: "MikroTik Clients", recommend: false },
};
export function metricMeta(metric) {
  return Object.prototype.hasOwnProperty.call(METRICS, metric) ? METRICS[metric] : null;
}

// Server-room local hour (UTC+8) — so the per-hour-of-day baseline labels "2 PM" the way
// the operators read the clock. Influx timestamps are UTC; we offset for bucketing only.
const TZ_OFFSET_H = 8;
const localHour = (ms) => (new Date(ms).getUTCHours() + TZ_OFFSET_H) % 24;

// ─── Generic series fetch ─────────────────────────────────────────────────────
// Returns sorted [{ t: epochMs, y }]. rangeExpr ("-48h"/"-14d") and every ("15m"/"1h")
// are built internally from clamped numbers by callers — never raw user input — so the
// Flux stays injection-safe (same posture as serverHistoryHandler.js).
async function fetchMetricSeries(metric, { deviceId = null, rangeExpr = "-14d", every = "1h" } = {}) {
  const meta = METRICS[metric];
  if (!meta) return [];

  if (meta.source === "server" || meta.source === "router") {
    const measurement = meta.source === "router" ? "router_metrics" : "server_metrics";
    const idFilter =
      deviceId != null
        ? `|> filter(fn: (r) => r.device_id == "${Number(deviceId)}")`
        : "";
    const flux = `
      from(bucket: "${bucket}")
        |> range(start: ${rangeExpr})
        |> filter(fn: (r) => r._measurement == "${measurement}")
        |> filter(fn: (r) => r._field == "${meta.field}")
        ${idFilter}
        |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)
        |> keep(columns: ["_time", "_value"])
    `;
    const rows = await queryClient.collectRows(flux);
    return rows
      .filter((r) => r._value != null)
      .map((r) => ({ t: Date.parse(r._time), y: Number(r._value) }))
      .sort((a, b) => a.t - b.t);
  }

  // environment (room-level, no device)
  if (metric === "gas") {
    const flux = `
      from(bucket: "${bucket}")
        |> range(start: ${rangeExpr})
        |> filter(fn: (r) => r._measurement == "sensor_environment")
        |> filter(fn: (r) => r._field == "mq2_1_ppm" or r._field == "mq2_2_ppm")
        |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)
        |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
    `;
    const rows = await queryClient.collectRows(flux);
    return rows
      .map((r) => ({
        t: Date.parse(r._time),
        y: Math.max(Number(r.mq2_1_ppm ?? -Infinity), Number(r.mq2_2_ppm ?? -Infinity)),
      }))
      .filter((p) => Number.isFinite(p.y))
      .sort((a, b) => a.t - b.t);
  }

  const flux = `
    from(bucket: "${bucket}")
      |> range(start: ${rangeExpr})
      |> filter(fn: (r) => r._measurement == "sensor_environment")
      |> filter(fn: (r) => r._field == "${meta.field}")
      |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)
      |> keep(columns: ["_time", "_value"])
  `;
  const rows = await queryClient.collectRows(flux);
  return rows
    .filter((r) => r._value != null)
    .map((r) => ({ t: Date.parse(r._time), y: Number(r._value) }))
    .sort((a, b) => a.t - b.t);
}

// ─── Phase 4 stats: percentiles ───────────────────────────────────────────────
// Linear-interpolated percentile (p in 0..100). Returns null for an empty set.
export function percentile(values, p) {
  const a = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  if (a.length === 1) return a[0];
  const idx = (p / 100) * (a.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const stddev = (a, m = mean(a)) => {
  if (a.length < 2) return 0;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

// ─── Phase 2 smoothing: EWMA + Holt's linear trend ────────────────────────────
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

// Window helper: pick an aggregate bucket appropriate to the lookback length.
const everyForHours = (h) => (h <= 24 ? "15m" : h <= 72 ? "30m" : "1h");
const parseEveryMs = (e) => {
  const m = /^(\d+)([smhd])$/.exec(e);
  if (!m) return 3_600_000;
  const n = Number(m[1]);
  return n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
};

// Short-horizon trend + projection for one metric (Phase 2). EWMA = smoothed history;
// Holt's linear = the forward projection. Returns the recent series, the projection, and
// the fitted trend so the UI can plot and caption it.
async function forecastTrend({ metric, deviceId = null, lookbackHours = 48, horizonHours = 12 } = {}) {
  const meta = METRICS[metric];
  if (!meta) return null;
  const hours = clampInt(lookbackHours, 6, 720, 48);
  const horizon = clampInt(horizonHours, 1, 168, 12);
  const every = everyForHours(hours);
  const series = await fetchMetricSeries(metric, { deviceId, rangeExpr: `-${hours}h`, every });

  const base = {
    metric, label: meta.label, unit: meta.unit, deviceId,
    lookbackHours: hours, horizonHours: horizon,
    alpha: 0.3, sampleCount: series.length,
    series: [], projection: [], trendPerHour: null, advice: null, status: "insufficient_data",
  };
  if (series.length < MIN_POINTS) return base;

  const values = series.map((p) => p.y);
  const sm = ewma(values, base.alpha);
  const holt = holtLinear(sm); // smooth first, then fit trend — steadier projection
  const points = series.map((p, i) => ({
    t: new Date(p.t).toISOString(), value: round2(p.y), ewma: round2(sm[i]),
  }));

  const projection = [];
  let trendPerHour = null;
  if (holt) {
    const stepMs = parseEveryMs(every);
    const steps = Math.min(200, Math.max(1, Math.round((horizon * 3_600_000) / stepMs)));
    const lastT = series[series.length - 1].t;
    trendPerHour = round2((holt.trend * 3_600_000) / stepMs);
    for (let k = 1; k <= steps; k++) {
      let v = holt.forecast(k);
      if (meta.bounded != null) v = Math.min(meta.bounded, Math.max(0, v));
      projection.push({ t: new Date(lastT + k * stepMs).toISOString(), value: round2(v) });
    }
  }

  // Predictive advice: does the projection cross an alert threshold within the horizon?
  // Grounded in the metric's effective alert_rules (high-side ">" rules — all our metrics
  // alarm on high), so the recommendation tracks the admin's own thresholds.
  const advice = await trendAdvice(metric, deviceId, values, projection, series[series.length - 1].t);

  return { ...base, series: points, projection, trendPerHour, advice, status: "ok" };
}

// Build the threshold-crossing advisory for a metric's projection (or null). Looks at the
// warning + critical rules; reports the worst one the projection reaches, with how soon.
async function trendAdvice(metric, deviceId, values, projection, lastT) {
  if (!projection.length) return null;
  const rules = await alertRulesService.getEffectiveRules(deviceId, metric);
  const lastVal = values[values.length - 1];
  const cross = (severity) => {
    const rule = rules.find(
      (r) => r.severity === severity && (r.comparison === ">" || r.comparison === ">="),
    );
    if (!rule) return null;
    const thr = Number(rule.threshold_value);
    const hit = projection.find((p) => p.value >= thr);
    if (!hit) return null;
    return {
      level: severity,
      severity,
      threshold: thr,
      already: lastVal >= thr,
      etaHours: Math.max(0, Math.round((Date.parse(hit.t) - lastT) / 3_600_000)),
      action: actionFor(metric),
    };
  };
  return cross("critical") ?? cross("warning"); // worst applicable first
}

// ─── Phase 3: anomaly detection (per-hour-of-day z-score + global IQR) ─────────
// Flags readings abnormal FOR THEIR HOUR — a 2 AM CPU spike that's still under a static
// threshold is caught here. Baseline = mean/σ per local hour bucket; |z| > zThresh ⇒
// anomaly. Global IQR fences are returned alongside for context. Statistics, not ML.
const ANOM_MIN_BUCKET = 5; // need ≥5 samples in an hour before its baseline is trusted

async function detectAnomalies({ metric, deviceId = null, lookbackDays = 7, z = 3 } = {}) {
  const meta = METRICS[metric];
  if (!meta) return null;
  const days = clampInt(lookbackDays, 1, 90, 7);
  const zThresh = clampNum(z, 2, 5, 3);
  const series = await fetchMetricSeries(metric, { deviceId, rangeExpr: `-${days}d`, every: "15m" });

  const base = {
    metric, label: meta.label, unit: meta.unit, deviceId, days, z: zThresh,
    baseline: [], iqr: null, anomalies: [], totalPoints: series.length, anomalyCount: 0,
    status: "insufficient_data",
  };
  if (series.length < MIN_POINTS * 2) return base;

  // per-hour-of-day baseline
  const buckets = Array.from({ length: 24 }, () => []);
  for (const p of series) buckets[localHour(p.t)].push(p.y);
  const stats = buckets.map((vals, hour) => {
    const m = vals.length ? mean(vals) : null;
    return { hour, n: vals.length, mean: m == null ? null : round2(m), std: round2(stddev(vals, m ?? 0)) };
  });

  // global IQR fences (Tukey, 1.5·IQR)
  const all = series.map((p) => p.y);
  const q1 = percentile(all, 25), q3 = percentile(all, 75);
  const iqr = q3 - q1;
  const fences = { q1: round2(q1), q3: round2(q3), lowerFence: round2(q1 - 1.5 * iqr), upperFence: round2(q3 + 1.5 * iqr) };

  const anomalies = [];
  for (const p of series) {
    const b = stats[localHour(p.t)];
    if (b.mean == null || b.n < ANOM_MIN_BUCKET || b.std <= 0) continue;
    const zv = (p.y - b.mean) / b.std;
    if (Math.abs(zv) <= zThresh) continue;
    anomalies.push({
      t: new Date(p.t).toISOString(),
      value: round2(p.y),
      expected: b.mean,
      z: round2(zv),
      hour: b.hour,
      direction: zv > 0 ? "high" : "low",
      iqrOutlier: p.y > fences.upperFence || p.y < fences.lowerFence,
    });
  }
  anomalies.sort((a, b) => Date.parse(b.t) - Date.parse(a.t)); // most recent first

  return {
    ...base,
    baseline: stats,
    iqr: fences,
    anomalies: anomalies.slice(0, 100),
    anomalyCount: anomalies.length,
    status: "ok",
  };
}

// ─── Phase 4: threshold recommendations (percentiles vs current rules) ─────────
// Suggests warn = p95, crit = p99 from the historical distribution, compared to the
// current GLOBAL alert_rules (device_id NULL) so an admin can tune away false alarms.
// Server metrics pool all servers (the global rule's scope). Closes the analytics loop.
function roundForUnit(v, meta) {
  if (v == null) return null;
  if (meta.unit === "%") return Math.min(meta.bounded ?? 100, Math.round(v));
  if (meta.unit === "°C") return round1(v);
  return Math.round(v); // ppm
}

async function recommendThresholds({ lookbackDays = 14 } = {}) {
  const days = clampInt(lookbackDays, 1, 90, 14);
  const out = [];
  for (const [metric, meta] of Object.entries(METRICS)) {
    if (meta.recommend === false) continue; // device-class metrics opt out of threshold recs
    const series = await fetchMetricSeries(metric, { rangeExpr: `-${days}d`, every: "30m" });
    const rules = await alertRulesService.getEffectiveRules(null, metric);
    const cw = rules.find((r) => r.severity === "warning");
    const cc = rules.find((r) => r.severity === "critical");
    const currentWarn = cw ? Number(cw.threshold_value) : null;
    const currentCrit = cc ? Number(cc.threshold_value) : null;

    const row = {
      metric, label: meta.label, unit: meta.unit, sampleCount: series.length,
      p50: null, p95: null, p99: null, max: null,
      suggestedWarn: null, suggestedCrit: null,
      currentWarn, currentCrit,
      currentWarnId: cw?.alert_rule_id ?? null, currentCritId: cc?.alert_rule_id ?? null,
      status: "insufficient_data",
    };
    if (series.length < MIN_POINTS) { out.push(row); continue; }

    const vals = series.map((p) => p.y);
    let warn = roundForUnit(percentile(vals, 95), meta);
    let crit = roundForUnit(percentile(vals, 99), meta);
    if (warn != null && crit != null && crit <= warn) crit = roundForUnit(warn + (meta.unit === "°C" ? 1 : 2), meta);
    out.push({
      ...row,
      p50: roundForUnit(percentile(vals, 50), meta),
      p95: roundForUnit(percentile(vals, 95), meta),
      p99: roundForUnit(percentile(vals, 99), meta),
      max: roundForUnit(Math.max(...vals), meta),
      suggestedWarn: warn,
      suggestedCrit: crit,
      status: "ok",
    });
  }
  return out;
}

// ─── Phase 2b/3b: UPS battery degradation + link saturation ───────────────────
// The router/UPS data this engine forecasts on (ups_metrics / network_traffic). Same
// regression core as disk-full ETA, but projected DOWN to a runtime floor (battery
// aging) or UP to a utilization ceiling (link saturation). See predictive-analytics.md
// §8. Additive — no change to the server/environment paths above.

// Hourly-averaged field grouped by device (+ optional extra tag, e.g. interface_name).
async function fetchSeriesGrouped(measurement, field, { deviceId = null, days = 30, keys = [] } = {}) {
  const d = clampInt(days, 1, 90, 30);
  const idFilter = deviceId != null ? `|> filter(fn: (r) => r.device_id == "${Number(deviceId)}")` : "";
  const cols = ["_time", "_value", "device_id", "device_name", ...keys];
  const flux = `
    from(bucket: "${bucket}")
      |> range(start: -${d}d)
      |> filter(fn: (r) => r._measurement == "${measurement}")
      |> filter(fn: (r) => r._field == "${field}")
      ${idFilter}
      |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)
      |> keep(columns: [${cols.map((c) => `"${c}"`).join(", ")}])
  `;
  const rows = await queryClient.collectRows(flux);
  const map = new Map();
  for (const r of rows) {
    if (r._value == null) continue;
    const sub = keys.map((k) => r[k]).filter(Boolean).join(" ");
    const gkey = keys.length ? `${r.device_id}|${sub}` : String(r.device_id);
    if (!map.has(gkey)) {
      map.set(gkey, { deviceId: Number(r.device_id), name: r.device_name ?? `Device ${r.device_id}`, sub, raw: [] });
    }
    map.get(gkey).raw.push({ t: Date.parse(r._time), y: Number(r._value) });
  }
  return map;
}

// Linear projection of a series to a bound. direction "down" = value falling to a floor
// (UPS runtime); "up" = value rising to a ceiling (link utilization). Mirrors
// forecastSeries() gating (R² ≥ MIN_ETA_R2, horizon ≤ MAX_ETA_DAYS) so a noisy/flat
// series reports "stable" rather than a bogus date.
function projectToBound(raw, { bound, direction }) {
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

  let r2 = model.r2, mae = model.mae;
  if (points.length >= 10) {
    const { train, test } = splitTrainTest(points, 0.8);
    const tm = linearRegression(train);
    if (tm && test.length >= 2) ({ r2, mae } = score(tm, test));
  }
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

const byEtaAsc = (a, b) => {
  if (a.etaDays == null && b.etaDays == null) return 0;
  if (a.etaDays == null) return 1;
  if (b.etaDays == null) return -1;
  return a.etaDays - b.etaDays;
};

// UPS battery degradation: regress runtime_remaining_min down to a critical floor →
// "replace battery in ~N days" (the UPS analogue of disk-full ETA). Runtime depends on
// load, so this is most reliable when load is steady; the R² gate guards the rest.
async function forecastUpsBattery({ deviceId = null, lookbackDays = 30, floorMinutes = 5 } = {}) {
  const floor = clampNum(floorMinutes, 1, 60, 5);
  const grouped = await fetchSeriesGrouped("ups_metrics", "runtime_remaining_min", { deviceId, days: lookbackDays });
  const results = [];
  for (const e of grouped.values()) {
    const p = projectToBound(e.raw, { bound: floor, direction: "down" });
    const eta = p.etaDays;
    const advice =
      p.status === "reached"
        ? { level: "critical", message: `${e.name}: runtime at/below ${floor} min — replace the battery now.` }
        : p.status === "declining" && eta != null && eta < 14
          ? { level: "critical", message: `${e.name}: battery runtime projected below ${floor} min in ~${eta} days — schedule replacement.` }
          : p.status === "declining" && eta != null && eta < 60
            ? { level: "warning", message: `${e.name}: battery runtime declining — projected critical in ~${eta} days. Plan a replacement.` }
            : null;
    results.push({
      deviceId: e.deviceId, name: e.name, floorMinutes: floor,
      currentRuntimeMin: p.current, slopePerDay: p.slopePerDay, etaDays: eta,
      fitR2: p.fitR2, mae: p.mae, confidence: p.confidence,
      sampleCount: p.sampleCount, status: p.status, advice,
    });
  }
  results.sort(byEtaAsc);
  return results;
}

// Link saturation: regress per-interface utilization_pct UP to a ceiling →
// "uplink hits 90% in ~N days". Network capacity planning.
async function forecastLinkSaturation({ deviceId = null, lookbackDays = 30, ceiling = 90 } = {}) {
  const cap = clampNum(ceiling, 50, 100, 90);
  const grouped = await fetchSeriesGrouped("network_traffic", "utilization_pct", { deviceId, days: lookbackDays, keys: ["interface_name"] });
  const results = [];
  for (const e of grouped.values()) {
    const p = projectToBound(e.raw, { bound: cap, direction: "up" });
    const eta = p.etaDays;
    const advice =
      p.status === "reached"
        ? { level: "critical", message: `${e.name} ${e.sub}: link at/above ${cap}% — upgrade the uplink or rebalance traffic.` }
        : p.status === "rising" && eta != null && eta < 14
          ? { level: "critical", message: `${e.name} ${e.sub}: projected to reach ${cap}% in ~${eta} days — plan an uplink upgrade.` }
          : p.status === "rising" && eta != null && eta < 60
            ? { level: "warning", message: `${e.name} ${e.sub}: utilization trending up — projected to hit ${cap}% in ~${eta} days.` }
            : null;
    results.push({
      deviceId: e.deviceId, name: e.name, interface: e.sub, ceiling: cap,
      currentUtil: p.current, slopePerDay: p.slopePerDay, etaDays: eta,
      fitR2: p.fitR2, mae: p.mae, confidence: p.confidence,
      sampleCount: p.sampleCount, status: p.status, advice,
    });
  }
  results.sort(byEtaAsc);
  return results;
}

export default {
  linearRegression,
  score,
  splitTrainTest,
  forecastDiskFull,
  alertSummary,
  metricMeta,
  percentile,
  ewma,
  holtLinear,
  forecastTrend,
  detectAnomalies,
  recommendThresholds,
  forecastUpsBattery,
  forecastLinkSaturation,
};
