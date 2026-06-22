import db from "../config/mysql.js";
import { queryClient, bucket } from "../config/influx.js";

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

// ─── Disk-full ETA forecast ───────────────────────────────────────────────────
const MIN_POINTS = 6;       // need a real series before we trust a slope
const STABLE_EPS = 0.0001;  // %/hour below this magnitude = effectively flat

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
      status = "full";
    } else {
      const xFull = (full - model.intercept) / model.slope;
      etaDays = Math.max(0, (xFull - lastX) / 24);
      status = "filling";
    }
  } else if (model.slope < -STABLE_EPS) {
    status = "falling";
  }

  return {
    ...base,
    slopePerDay: round2(slopePerDay),
    etaDays: etaDays == null ? null : round1(etaDays),
    fitR2: r2 == null ? null : round2(r2),
    mae: mae == null ? null : round2(mae),
    confidence: confidenceLabel(r2),
    status,
  };
}

// Disk-full ETA for every server with data (or one, if deviceId given). Soonest
// ETA first; "no ETA" (stable/falling/insufficient) sinks to the bottom.
async function forecastDiskFull({ deviceId = null, lookbackDays = 14, full = 100 } = {}) {
  const fullPct = clampNum(full, 50, 100, 100);
  const byDevice = await fetchDiskSeries(lookbackDays, deviceId);
  const results = [];
  for (const entry of byDevice.values()) results.push(forecastSeries(entry, fullPct));
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

export default {
  linearRegression,
  score,
  splitTrainTest,
  forecastDiskFull,
  alertSummary,
};
