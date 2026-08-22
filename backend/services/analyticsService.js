import db from "../config/mysql.js";
import { queryClient, bucket } from "../config/influx.js";
import alertRulesService from "./alertRulesService.js";
import {
  MIN_POINTS,
  linearRegression, score, splitTrainTest, percentile,
  ewma, holtLinear, forecastSeasonal, assessSeries,
  forecastSeries, projectToBound, worstVolumeForecast, byEtaAsc,
  round1, round2, clampInt, clampNum, confidenceLabel, mean, stddev,
  everyForHours, parseEveryMs, bucketForDays, spanDays,
  BASELINE_BUCKETS, baselineBucket, bucketLabel, backtestSeries,
  actionFor,
} from "./analyticsMath.js";

// Predictive analytics engine. The STATISTICS live in `analyticsMath.js` (import-free,
// unit-tested under backend/tests/); this file is the I/O half — InfluxDB reads, MySQL
// reads, and the shaping of results for the API. See predictive-analytics.md for the
// math (§2–§4) and the roadmap (§8).
//
// Re-exported so the public surface is unchanged for anything importing from here.
export {
  linearRegression, score, splitTrainTest, percentile, ewma, holtLinear,
} from "./analyticsMath.js";

// ─── Device identity ──────────────────────────────────────────────────────────
// MySQL is the ONLY authority on what a device is called. The InfluxDB `device_name`
// tag is stamped at write time and never rewritten, so history spans every name a
// device has ever had — and since we group by device_id and read the name off the
// first row, an un-resolved forecast would show the OLDEST label. A server renamed
// from the dashboard (devices.display_name) would keep reporting its raw hostname
// here while every other page shows the friendly name.
//
// display_name lives on the shared `devices` table, so the same COALESCE resolves
// servers, routers, MikroTik and UPS identically — matching agentService's
// effective-name rule. Devices absent from MySQL (the 9001/9002/9101 dev-seed ids,
// or a decommissioned row whose Influx history outlives it) keep the tag name.
const DEVICE_TYPE_LABEL = {
  server: "Server",
  router: "Router",
  mikrotik: "MikroTik",
  ups: "UPS",
  esp32: "Sensor",
  aircon: "Aircon",
};

async function fetchDeviceIdentities(ids) {
  const clean = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (!clean.length) return new Map();
  const [rows] = await db.query(
    `SELECT device_id,
            COALESCE(NULLIF(display_name, ''), device_name) AS name,
            device_name AS hostname,
            display_name AS displayName,
            device_type  AS type,
            location
       FROM devices
      WHERE device_id IN (?)`,
    [clean],
  );
  return new Map(
    rows.map((r) => [
      Number(r.device_id),
      {
        name: r.name,
        hostname: r.hostname,
        displayName: r.displayName ?? null,
        type: r.type,
        typeLabel: DEVICE_TYPE_LABEL[r.type] ?? r.type,
        location: r.location ?? null,
      },
    ]),
  );
}

// Overlay the authoritative identity onto a grouped series entry, falling back to the
// Influx tag when MySQL has no such device.
function identify(entry, identities) {
  const id = identities.get(Number(entry.deviceId));
  return {
    name: id?.name ?? entry.name,
    hostname: id?.hostname ?? null,
    deviceType: id?.type ?? null,
    typeLabel: id?.typeLabel ?? null,
    location: id?.location ?? null,
  };
}

// ─── Which series belong on an "all devices" list ─────────────────────────────
// A device whose newest sample is older than this is offline / decommissioned, so it is
// excluded from the all-devices forecasts (you can't forecast something that stopped
// reporting). An explicit single-device request is always shown regardless.
const ACTIVE_WITHIN_MS = 24 * 60 * 60 * 1000;

// InfluxDB history OUTLIVES the MySQL device row. Removing a device from the dashboard
// deletes its `devices` row but not its measurements, and re-adding the same hardware
// mints a NEW device_id — so a router that has been removed and re-added a few times
// leaves one orphaned series per retired id. Grouping is by device_id, so each of those
// ghosts renders as its own row: the same five interfaces repeated once per past
// registration, with no MySQL row to name or classify them.
//
// A device_id with no `devices` row is therefore not a device any more, and is dropped
// from list views. This also excludes the dev-seed ids (9001/9002/9101) written by
// scripts/seed-analytics-history.js unless they are registered in MySQL — real data has
// superseded them. A single-device request (`deviceId` given) still renders whatever it
// finds, so an explicit lookup can never come back mysteriously empty.
function isCurrentDevice(entry, identities, cutoff) {
  if (!identities.has(Number(entry.deviceId))) return false; // retired / never registered
  const newest = entry.raw.reduce((m, p) => (p.t > m ? p.t : m), 0);
  return newest >= cutoff;
}

// ─── Disk-full ETA forecast ───────────────────────────────────────────────────

// Pull hourly-averaged disk_percent per server. Window + device id are whitelisted
// (clamped int / Number) before they touch Flux — no injection surface, mirroring
// serverHistoryHandler.js.
async function fetchDiskSeries(lookbackDays, deviceId) {
  const days = clampInt(lookbackDays, 1, 365, 30);
  const every = bucketForDays(days);
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
      |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)
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

// Disk-full ETA for every server with data (or one, if deviceId given). Soonest
// ETA first; "no ETA" (stable/falling/insufficient) sinks to the bottom.
//
// Forecasts EVERY fixed volume (`server_volumes`, one series per mount) and headlines the
// soonest to fill, because that is what disk alerting does: main moved checkThresholds to
// the worst volume, so regressing root-only `disk_percent` meant a server filling its data
// volume raised a Disk alert while the forecast beside it read "Stable". Servers with no
// per-volume history — pre-`server_volumes` data — still fall back to the root series.
async function forecastDiskFull({ deviceId = null, lookbackDays = 30, full = 100 } = {}) {
  const fullPct = clampNum(full, 50, 100, 100);
  const [byDevice, volGrouped] = await Promise.all([
    fetchDiskSeries(lookbackDays, deviceId),
    fetchSeriesGrouped("server_volumes", "percent", {
      deviceId,
      days: clampInt(lookbackDays, 1, 365, 30),
      keys: ["mount"],
    }),
  ]);
  const cutoff = Date.now() - ACTIVE_WITHIN_MS;
  const identities = await fetchDeviceIdentities([...byDevice.values()].map((e) => e.deviceId));

  const volsByDevice = new Map();
  for (const v of volGrouped.values()) {
    if (!v.sub) continue; // no mount tag = not a per-volume point
    if (!volsByDevice.has(v.deviceId)) volsByDevice.set(v.deviceId, []);
    volsByDevice.get(v.deviceId).push(v);
  }

  const results = [];
  for (const entry of byDevice.values()) {
    // When listing ALL servers, drop retired/stale enrollments — including the duplicate
    // "ghost" an unstable agent MAC leaves behind in InfluxDB.
    if (deviceId == null && !isCurrentDevice(entry, identities, cutoff)) continue;
    const ident = identify(entry, identities);
    const vols = volsByDevice.get(Number(entry.deviceId)) ?? [];

    if (!vols.length) {
      // No per-volume history: root-only forecast, exactly as before.
      results.push({
        ...forecastSeries({ ...entry, name: ident.name }, fullPct),
        ...ident,
        mount: null,
        volumes: [],
        historyDays: spanDays(entry.raw),
      });
      continue;
    }

    // Name each volume's advice by its mount only when there's more than one, mirroring
    // how agentService phrases the alert ("Disk critical (D:\)").
    const multi = vols.length > 1;
    const perVolume = vols.map((v) => ({
      ...forecastSeries(
        { deviceId: entry.deviceId, name: multi ? `${ident.name} (${v.sub})` : ident.name, raw: v.raw },
        fullPct,
      ),
      mount: v.sub,
    }));
    const headline = worstVolumeForecast(perVolume);
    results.push({
      ...headline,
      ...ident,
      mount: headline.mount,
      historyDays: spanDays(entry.raw),
      volumes: perVolume
        .map((v) => ({
          mount: v.mount,
          currentPercent: v.currentPercent,
          slopePerDay: v.slopePerDay,
          etaDays: v.etaDays,
          status: v.status,
          confidence: v.confidence,
        }))
        .sort((a, b) => (b.currentPercent ?? -1) - (a.currentPercent ?? -1)),
    });
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
  // Same effective-name rule as everywhere else (§14): the admin's display_name wins,
  // so a renamed server is named here exactly as it is on the Servers page. A NULL
  // device_id is a room-level environment alert, which has no device row by design.
  const [topDevices] = await db.query(
    `SELECT a.device_id AS deviceId,
            COALESCE(NULLIF(d.display_name, ''), d.device_name, 'Room / environment') AS name,
            d.device_type AS type,
            COUNT(*) AS c
       FROM alerts a LEFT JOIN devices d ON d.device_id = a.device_id
      WHERE a.${since}
      GROUP BY a.device_id, name, d.device_type ORDER BY c DESC LIMIT 5`,
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
      typeLabel: r.type ? (DEVICE_TYPE_LABEL[r.type] ?? r.type) : null,
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
  // ICMP link quality. Present on EVERY router — the SNMP ones (ping runs alongside the
  // walk) and the ping-only ones, for which these two are the only numeric metrics that
  // exist at all. Without them a ping-only router had nothing to trend, nothing to check
  // for anomalies, and no way to be told what its own thresholds should be.
  //
  // `recommend: "scoped"` on latency: it is the one metric here whose right value is a
  // property of the individual link, so a fleet-wide percentile would mix a rack switch
  // answering in under 1 ms with an ISP CPE answering in 30 ms and recommend a number
  // that fits neither. Per device it is exactly the right tool — and it closes the loop
  // on router_latency shipping INACTIVE (migration 2026-08-22): instead of "watch it for
  // a few days and pick 2-3x", the p95/p99 of what this link actually does is computed
  // and an admin applies it in one click.
  router_latency: { source: "router", field: "latency_ms", unit: "ms", label: "Latency", recommend: "scoped" },
  // Loss is NOT site-specific — 0% is healthy on every link everywhere — so the seeded
  // 5/20 global rule is already right and a percentile recommendation would only ever
  // talk you into a worse one. Trend + anomaly still apply.
  router_loss: { source: "router", field: "packet_loss_pct", unit: "%", label: "Packet Loss", bounded: 100, recommend: false },
};
export function metricMeta(metric) {
  return Object.prototype.hasOwnProperty.call(METRICS, metric) ? METRICS[metric] : null;
}

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

// Trend + projection for one metric (Phase 2). EWMA smooths the history for DISPLAY;
// the projection is Holt's method on the DESEASONALISED series, with the daily shape put
// back on afterwards (analyticsMath.forecastSeasonal).
//
// It used to be plain Holt's linear on the EWMA — a straight line — and over a 12 h
// horizon on room temperature that was not a small error. A projection made at 11 PM
// picked up the evening's falling limb and ran it through dawn into midday, predicting
// the day's coolest figure for the hour the room is hottest: ~8 °C out, in the wrong
// direction. Fitting the smoothed series compounded it, opening the projection ~2 °C
// away from the reading shown beside it on the same page.
//
// The lookback is also wider by default now: a daily shape cannot be estimated from a
// window that does not contain several days of it.
async function forecastTrend({ metric, deviceId = null, lookbackHours = 168, horizonHours = 12 } = {}) {
  const meta = METRICS[metric];
  if (!meta) return null;
  // Floor raised to 48 h: below two days there is no daily shape to estimate, and the
  // projection silently degrades to the straight line this function exists to stop being.
  const hours = clampInt(lookbackHours, 48, 720, 168);
  const horizon = clampInt(horizonHours, 1, 168, 12);
  const every = everyForHours(hours);
  const series = await fetchMetricSeries(metric, { deviceId, rangeExpr: `-${hours}h`, every });

  const base = {
    metric, label: meta.label, unit: meta.unit, deviceId,
    lookbackHours: hours, horizonHours: horizon,
    alpha: 0.3, sampleCount: series.length,
    series: [], projection: [], trendPerHour: null, advice: null,
    seasonal: false, profileHours: 0, profileCycles: 0,
    dataQuality: null,
    status: "insufficient_data",
  };
  if (series.length < MIN_POINTS) return base;

  const values = series.map((p) => p.y);
  const sm = ewma(values, base.alpha); // display only — never fed to the fit
  const points = series.map((p, i) => ({
    t: new Date(p.t).toISOString(), value: round2(p.y), ewma: round2(sm[i]),
  }));

  const stepMs = parseEveryMs(every);

  // REFUSE to project from a window that cannot support one. The history is still
  // returned — it is real and worth looking at — but `projection` stays empty and
  // `dataQuality` says exactly what is missing.
  //
  // The alternative, which this replaces, was to quietly fall back to a straight line.
  // That is the worse failure: the page looked identical, the numbers looked confident,
  // and nothing on screen distinguished "here is the daily cycle" from "the sensor has
  // never seen a morning, so here is a guess". A forecast that admits it does not know
  // is more useful than one that does not.
  const quality = assessSeries(series, { stepMs });
  if (!quality.ok) {
    return { ...base, series: points, dataQuality: quality, status: "insufficient_history" };
  }

  const fc = forecastSeasonal(series, { horizonMs: horizon * 3_600_000, stepMs });

  const projection = [];
  let trendPerHour = null;
  if (fc) {
    trendPerHour = round2(fc.trendPerHour);
    for (const p of fc.points.slice(0, 200)) {
      let v = p.value;
      if (meta.bounded != null) v = Math.min(meta.bounded, Math.max(0, v));
      projection.push({ t: new Date(p.t).toISOString(), value: round2(v) });
    }
    base.seasonal = fc.seasonal;
    base.profileHours = fc.profile.hoursCovered;
    base.profileCycles = fc.profile.cycles;
  }

  // Predictive advice: does the projection cross an alert threshold within the horizon?
  // Grounded in the metric's effective alert_rules (high-side ">" rules — all our metrics
  // alarm on high), so the recommendation tracks the admin's own thresholds.
  const advice = await trendAdvice(metric, deviceId, values, projection, series[series.length - 1].t);

  return { ...base, series: points, projection, trendPerHour, advice, dataQuality: quality, status: "ok" };
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
// Need this many samples in a bucket before its baseline is trusted. At the 14-day
// default and 15m sampling that is ~40 weekday and ~16 weekend samples per hour bucket,
// comfortably clear of it even after the day-type split.
const ANOM_MIN_BUCKET = 5;

async function detectAnomalies({ metric, deviceId = null, lookbackDays = 14, z = 3 } = {}) {
  const meta = METRICS[metric];
  if (!meta) return null;
  const days = clampInt(lookbackDays, 1, 90, 14);
  const zThresh = clampNum(z, 2, 5, 3);
  const series = await fetchMetricSeries(metric, { deviceId, rangeExpr: `-${days}d`, every: "15m" });

  const base = {
    metric, label: meta.label, unit: meta.unit, deviceId, days, z: zThresh,
    baseline: [], iqr: null, anomalies: [], totalPoints: series.length, anomalyCount: 0,
    status: "insufficient_data",
  };
  if (series.length < MIN_POINTS * 2) return base;

  // Baseline per (day-type, hour): 48 buckets, weekday 0-23 then weekend 24-47. Pooling
  // all seven days made a campus weekend drag the mean down and widen the deviation,
  // which blinded the detector on weekdays and could flag a normal Sunday. See
  // analyticsMath.baselineBucket.
  const buckets = Array.from({ length: BASELINE_BUCKETS }, () => []);
  for (const p of series) buckets[baselineBucket(p.t)].push(p.y);
  const stats = buckets.map((vals, idx) => {
    const m = vals.length ? mean(vals) : null;
    const { hour, dayType } = bucketLabel(idx);
    return {
      hour, dayType, n: vals.length,
      mean: m == null ? null : round2(m),
      std: round2(stddev(vals, m ?? 0)),
    };
  });

  // global IQR fences (Tukey, 1.5·IQR)
  const all = series.map((p) => p.y);
  const q1 = percentile(all, 25), q3 = percentile(all, 75);
  const iqr = q3 - q1;
  const fences = { q1: round2(q1), q3: round2(q3), lowerFence: round2(q1 - 1.5 * iqr), upperFence: round2(q3 + 1.5 * iqr) };

  const anomalies = [];
  for (const p of series) {
    const b = stats[baselineBucket(p.t)];
    if (!b || b.mean == null || b.n < ANOM_MIN_BUCKET || b.std <= 0) continue;
    const zv = (p.y - b.mean) / b.std;
    if (Math.abs(zv) <= zThresh) continue;
    anomalies.push({
      t: new Date(p.t).toISOString(),
      value: round2(p.y),
      expected: b.mean,
      z: round2(zv),
      hour: b.hour,
      dayType: b.dayType,
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

// `deviceId` narrows the suggestion to ONE server. Pooling every server (the default,
// matching the global rule's scope) is right for a global default, but it is exactly wrong
// for a fleet that isn't uniform: a busy database server and an idle file server share a
// p95 that suits neither, so the global rule either cries wolf on the quiet box or stays
// silent on the loud one. A per-device suggestion is compared against that device's
// EFFECTIVE rules — its own override if it has one, else the global — so "in sync" means
// what it says.
async function recommendThresholds({ lookbackDays = 14, deviceId = null } = {}) {
  const days = clampInt(lookbackDays, 1, 90, 14);
  const scoped = deviceId != null;

  // When scoped, the device's CLASS decides which metrics are even askable. Looked up
  // here rather than taken as a caller-supplied hint: one indexed read, and a caller
  // cannot get it wrong. Without it, scoping to a router still evaluated cpu/mem/disk
  // against a router id — three guaranteed-empty Flux queries per request, surfacing as
  // three "insufficient data" rows that look like a broken collector rather than like a
  // question that was never sensible to ask.
  let scopedSource = "server";
  if (scoped) {
    const [[row]] = await db.query(
      `SELECT device_type FROM devices WHERE device_id = ? LIMIT 1`,
      [Number(deviceId)],
    );
    scopedSource = row?.device_type === "router" || row?.device_type === "mikrotik" ? "router" : "server";
  }
  const out = [];
  for (const [metric, meta] of Object.entries(METRICS)) {
    if (meta.recommend === false) continue; // device-class metrics opt out of threshold recs
    // `recommend: "scoped"` means the metric is only meaningful PER DEVICE — offering it
    // fleet-wide would average across populations that have no business being compared
    // (see router_latency in METRICS).
    const scopedOnly = meta.recommend === "scoped";
    if (scopedOnly && !scoped) continue;
    // Environment metrics are room-level: there is no per-device version of "the server
    // room is too hot", so a scoped request always skips them. Otherwise the metric must
    // belong to the class of device that was scoped to — asking a router for disk usage
    // is not a missing reading, it is a category error.
    if (scoped && meta.source === "env") continue;
    if (scoped && meta.source !== scopedSource) continue;
    const series = await fetchMetricSeries(metric, {
      deviceId: scoped ? deviceId : null,
      rangeExpr: `-${days}d`,
      every: "30m",
    });
    const rules = await alertRulesService.getEffectiveRules(scoped ? deviceId : null, metric);
    const cw = rules.find((r) => r.severity === "warning");
    const cc = rules.find((r) => r.severity === "critical");
    const currentWarn = cw ? Number(cw.threshold_value) : null;
    const currentCrit = cc ? Number(cc.threshold_value) : null;

    const row = {
      metric, label: meta.label, unit: meta.unit, sampleCount: series.length,
      deviceId: scoped ? deviceId : null,
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

// ─── Forecast accuracy (rolling-origin backtest) ──────────────────────────────
// Answers "were our forecasts right?" from the history already on disk, instead of
// recording live predictions and waiting weeks to grade them. See analyticsMath
// .backtestSeries for the method and why it scores VALUE error rather than ETA error.
//
// Reported per device so one badly-behaved server can't hide behind an average, and with
// the fold count visible — an accuracy figure from two folds is not the same claim as one
// from eight, and pretending otherwise would be the dishonest version of this feature.
async function forecastAccuracy({ metric = "disk", deviceId = null, lookbackDays = 30, horizonDays = 7, folds = 5 } = {}) {
  const meta = METRICS[metric];
  if (!meta) return null;
  const days = clampInt(lookbackDays, 2, 365, 30);
  const horizon = clampNum(horizonDays, 0.25, 90, 7);
  const foldCount = clampInt(folds, 1, 20, 5);
  const horizonMs = horizon * 86_400_000;

  const results = [];
  if (metric === "disk") {
    // Grade the SAME SERIES the disk forecast headlines. forecastDiskFull regresses every
    // volume and headlines the fastest-filling one, so backtesting root `disk_percent`
    // would silently score C: while the forecast above it projected D: — two different
    // series presented as though one explained the other. The headline volume is chosen
    // by the same worstVolumeForecast() call, so the graded series IS the projected one.
    const [byDevice, volGrouped] = await Promise.all([
      fetchDiskSeries(days, deviceId),
      fetchSeriesGrouped("server_volumes", "percent", { deviceId, days, keys: ["mount"] }),
    ]);
    const identities = await fetchDeviceIdentities([...byDevice.values()].map((e) => e.deviceId));
    const cutoff = Date.now() - ACTIVE_WITHIN_MS;

    const volsByDevice = new Map();
    for (const v of volGrouped.values()) {
      if (!v.sub) continue;
      if (!volsByDevice.has(v.deviceId)) volsByDevice.set(v.deviceId, []);
      volsByDevice.get(v.deviceId).push(v);
    }

    for (const entry of byDevice.values()) {
      if (deviceId == null && !isCurrentDevice(entry, identities, cutoff)) continue;
      const ident = identify(entry, identities);
      const vols = volsByDevice.get(Number(entry.deviceId)) ?? [];

      // No per-volume history (pre-`server_volumes` data) → root series, the same
      // fallback forecastDiskFull uses.
      let series = entry.raw;
      let mount = null;
      if (vols.length) {
        const perVolume = vols.map((v) => ({
          ...forecastSeries({ deviceId: entry.deviceId, name: ident.name, raw: v.raw }, 100),
          mount: v.sub,
          raw: v.raw,
        }));
        const headline = worstVolumeForecast(perVolume);
        if (headline) { series = headline.raw; mount = headline.mount; }
      }

      const bt = backtestSeries(series, { horizonMs, folds: foldCount });
      results.push({
        deviceId: entry.deviceId, name: ident.name, typeLabel: ident.typeLabel,
        mount, ...bt,
      });
    }
  } else if (meta.source === "env") {
    // Room-level: one series, no device.
    const series = await fetchMetricSeries(metric, { rangeExpr: `-${days}d`, every: bucketForDays(days) });
    const bt = backtestSeries(series, { horizonMs, folds: foldCount });
    results.push({ deviceId: null, name: "Server room", typeLabel: null, mount: null, ...bt });
  } else {
    const measurement = meta.source === "router" ? "router_metrics" : "server_metrics";
    const grouped = await fetchSeriesGrouped(measurement, meta.field, { deviceId, days });
    const identities = await fetchDeviceIdentities([...grouped.values()].map((e) => e.deviceId));
    const cutoff = Date.now() - ACTIVE_WITHIN_MS;
    for (const entry of grouped.values()) {
      if (deviceId == null && !isCurrentDevice(entry, identities, cutoff)) continue;
      const ident = identify(entry, identities);
      const bt = backtestSeries(entry.raw, { horizonMs, folds: foldCount });
      results.push({ deviceId: entry.deviceId, name: ident.name, typeLabel: ident.typeLabel, mount: null, ...bt });
    }
  }

  // Devices with no verifiable folds sink to the bottom — they have nothing to say yet.
  results.sort((a, b) => {
    if (!a.folds && !b.folds) return 0;
    if (!a.folds) return 1;
    if (!b.folds) return -1;
    return (b.mae ?? 0) - (a.mae ?? 0); // least accurate first: that's what needs looking at
  });

  const scored = results.filter((r) => r.folds > 0);
  return {
    metric, label: meta.label, unit: meta.unit,
    lookbackDays: days, horizonDays: horizon,
    devices: results,
    // Overall figure across devices, weighted by fold count so a device with one
    // verifiable prediction doesn't swing the headline.
    overallMae: scored.length
      ? round2(scored.reduce((a, r) => a + r.mae * r.folds, 0) / scored.reduce((a, r) => a + r.folds, 0))
      : null,
    totalFolds: scored.reduce((a, r) => a + r.folds, 0),
    status: scored.length ? "ok" : "insufficient_data",
  };
}

// ─── Phase 2b/3b: UPS battery degradation + link saturation ───────────────────
// The router/UPS data this engine forecasts on (ups_metrics / network_traffic). Same
// regression core as disk-full ETA, but projected DOWN to a runtime floor (battery
// aging) or UP to a utilization ceiling (link saturation). See predictive-analytics.md
// §8. Additive — no change to the server/environment paths above.

// Hourly-averaged field grouped by device (+ optional extra tag, e.g. interface_name).
async function fetchSeriesGrouped(measurement, field, { deviceId = null, days = 30, keys = [] } = {}) {
  const d = clampInt(days, 1, 365, 30);
  const every = bucketForDays(d);
  const idFilter = deviceId != null ? `|> filter(fn: (r) => r.device_id == "${Number(deviceId)}")` : "";
  const cols = ["_time", "_value", "device_id", "device_name", ...keys];
  const flux = `
    from(bucket: "${bucket}")
      |> range(start: -${d}d)
      |> filter(fn: (r) => r._measurement == "${measurement}")
      |> filter(fn: (r) => r._field == "${field}")
      ${idFilter}
      |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)
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

// UPS battery degradation: regress runtime_remaining_min down to a critical floor →
// "replace battery in ~N days" (the UPS analogue of disk-full ETA). Runtime depends on
// load, so this is most reliable when load is steady; the R² gate guards the rest.
// RFC 1628 upsBatteryStatus. The UPS's OWN verdict on its battery, which is worth more
// than a regression when it disagrees: a manufacturer saying "low" is a measurement, while
// our runtime trend is an inference from data that also moves with load. Stored by
// upsMetricsHandler precisely because it is the signal that reveals itself over months.
const BATTERY_STATUS = { 1: "unknown", 2: "normal", 3: "low", 4: "depleted" };

async function fetchBatteryStatus(deviceId, days) {
  const grouped = await fetchSeriesGrouped("ups_metrics", "battery_status", { deviceId, days });
  const out = new Map();
  for (const e of grouped.values()) {
    const sorted = [...e.raw].sort((a, b) => a.t - b.t);
    const latest = sorted[sorted.length - 1];
    if (!latest) continue;
    // Worst state seen in the window, not just the latest: a battery that dipped to
    // "low" under load and recovered is still a battery worth looking at.
    const worst = sorted.reduce((w, p) => (p.y > w ? p.y : w), 0);
    out.set(e.deviceId, {
      code: Math.round(latest.y),
      label: BATTERY_STATUS[Math.round(latest.y)] ?? "unknown",
      worstCode: Math.round(worst),
      worstLabel: BATTERY_STATUS[Math.round(worst)] ?? "unknown",
    });
  }
  return out;
}

async function forecastUpsBattery({ deviceId = null, lookbackDays = 180, floorMinutes = 5 } = {}) {
  const floor = clampNum(floorMinutes, 1, 60, 5);
  const [grouped, batteryStatus] = await Promise.all([
    fetchSeriesGrouped("ups_metrics", "runtime_remaining_min", { deviceId, days: lookbackDays }),
    fetchBatteryStatus(deviceId, lookbackDays),
  ]);
  const identities = await fetchDeviceIdentities([...grouped.values()].map((e) => e.deviceId));
  const cutoff = Date.now() - ACTIVE_WITHIN_MS;
  const results = [];
  for (const e of grouped.values()) {
    if (deviceId == null && !isCurrentDevice(e, identities, cutoff)) continue;
    const ident = identify(e, identities);
    const name = ident.name;
    const p = projectToBound(e.raw, { bound: floor, direction: "down" });
    const eta = p.etaDays;
    const status = batteryStatus.get(e.deviceId) ?? null;
    // The UPS's own verdict OVERRIDES the regression when it is worse. "depleted"/"low"
    // is a measurement from the device; our ETA is an inference from runtime that also
    // moves with load, so a quiet trend must never talk over the hardware.
    const declared =
      status && status.worstCode >= 4
        ? { level: "critical", message: `${name}: the UPS reports its battery as DEPLETED — replace it now, regardless of the runtime trend.` }
        : status && status.worstCode === 3
          ? { level: "warning", message: `${name}: the UPS reported battery LOW during this window — verify the battery even if runtime looks steady.` }
          : null;
    const advice =
      declared ??
      (p.status === "reached"
        ? { level: "critical", message: `${name}: runtime at/below ${floor} min — replace the battery now.` }
        : p.status === "declining" && eta != null && eta < 14
          ? { level: "critical", message: `${name}: battery runtime projected below ${floor} min in ~${eta} days — schedule replacement.` }
          : p.status === "declining" && eta != null && eta < 60
            ? { level: "warning", message: `${name}: battery runtime declining — projected critical in ~${eta} days. Plan a replacement.` }
            : null);
    results.push({
      deviceId: e.deviceId, ...ident, floorMinutes: floor, historyDays: spanDays(e.raw),
      batteryStatus: status?.label ?? null,
      batteryStatusWorst: status?.worstLabel ?? null,
      currentRuntimeMin: p.current, slopePerDay: p.slopePerDay, etaDays: eta,
      fitR2: p.fitR2, mae: p.mae, confidence: p.confidence,
      sampleCount: p.sampleCount, status: p.status, advice,
    });
  }
  results.sort(byEtaAsc);
  return results;
}

// Current per-interface labels from MySQL. Same authority argument as device names:
// `network_interfaces.location_label` is what an admin edits (and what the MikroTik
// poller re-syncs), while the Influx `location_label` tag is frozen at write time.
// Resolving here also keeps grouping keyed on interface_name alone — grouping on the
// label instead would split one port's history in two the moment someone relabels it.
async function fetchInterfaceLabels(deviceIds) {
  const clean = [...new Set(deviceIds.map(Number).filter(Number.isInteger))];
  if (!clean.length) return new Map();
  const [rows] = await db.query(
    `SELECT device_id, interface_name, location_label
       FROM network_interfaces
      WHERE device_id IN (?)`,
    [clean],
  );
  return new Map(
    rows
      .filter((r) => (r.location_label ?? "").trim())
      .map((r) => [`${Number(r.device_id)}|${r.interface_name}`, r.location_label.trim()]),
  );
}

// Link saturation: regress per-interface utilization_pct UP to a ceiling →
// "uplink hits 90% in ~N days". Network capacity planning.
//
// On the campus MikroTik an interface IS a building, so the location label is the name
// an operator actually recognises — "ether1" alone is unidentifiable when every router
// has one. We return both and let the UI lead with the label.
async function forecastLinkSaturation({ deviceId = null, lookbackDays = 90, ceiling = 90 } = {}) {
  const cap = clampNum(ceiling, 50, 100, 90);
  const grouped = await fetchSeriesGrouped("network_traffic", "utilization_pct", { deviceId, days: lookbackDays, keys: ["interface_name"] });
  const deviceIds = [...grouped.values()].map((e) => e.deviceId);
  const [identities, labels] = await Promise.all([
    fetchDeviceIdentities(deviceIds),
    fetchInterfaceLabels(deviceIds),
  ]);
  const cutoff = Date.now() - ACTIVE_WITHIN_MS;
  const results = [];
  for (const e of grouped.values()) {
    // Without this a router removed and re-added N times renders its whole interface
    // list N+1 times over — one block per retired device_id (see isCurrentDevice).
    if (deviceId == null && !isCurrentDevice(e, identities, cutoff)) continue;
    const ident = identify(e, identities);
    const ifName = e.sub;
    const label = labels.get(`${Number(e.deviceId)}|${ifName}`) ?? null;
    // "Core Router ether1 (ISP Uplink)" — device, port, and what the port actually serves.
    const where = `${ident.name} ${ifName}${label ? ` (${label})` : ""}`;
    const p = projectToBound(e.raw, { bound: cap, direction: "up" });
    const eta = p.etaDays;
    const advice =
      p.status === "reached"
        ? { level: "critical", message: `${where}: link at/above ${cap}% — upgrade the uplink or rebalance traffic.` }
        : p.status === "rising" && eta != null && eta < 14
          ? { level: "critical", message: `${where}: projected to reach ${cap}% in ~${eta} days — plan an uplink upgrade.` }
          : p.status === "rising" && eta != null && eta < 60
            ? { level: "warning", message: `${where}: utilization trending up — projected to hit ${cap}% in ~${eta} days.` }
            : null;
    results.push({
      deviceId: e.deviceId, ...ident, historyDays: spanDays(e.raw),
      interface: ifName, interfaceLabel: label, ceiling: cap,
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
  forecastAccuracy,
};
