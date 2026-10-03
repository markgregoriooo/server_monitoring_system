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

// Predictive analytics: InfluxDB and MySQL reads and result shaping. The statistics
// are in analyticsMath.js (no imports, unit-tested). See predictive-analytics.md
// §2–§4 for the math and §8 for the roadmap. Re-exported so existing imports work.
export {
  linearRegression, score, splitTrainTest, percentile, ewma, holtLinear,
} from "./analyticsMath.js";

// ─── Device identity ──────────────────────────────────────────────────────────
// Device names come from MySQL, not the InfluxDB `device_name` tag, which is set
// at write time and never updated. Otherwise a renamed device would show its old
// name here. Same COALESCE(display_name, device_name) rule as agentService. Devices
// missing from MySQL keep the tag name.
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

// ─── Which series go on an "all devices" list ─────────────────────────────
// Devices whose newest sample is older than this are offline or removed, so they
// are left out of the all-devices forecasts. A single-device request always shows.
const ACTIVE_WITHIN_MS = 24 * 60 * 60 * 1000;

// InfluxDB history outlives the devices row, and re-adding a device gives it a new
// id, so a device removed and re-added leaves old series behind. A device_id with
// no devices row is dropped from list views (this also hides the dev-seed ids
// 9001/9002/9101). A single-device request still shows whatever it finds.
function isCurrentDevice(entry, identities, cutoff) {
  if (!identities.has(Number(entry.deviceId))) return false; // retired / never registered
  const newest = entry.raw.reduce((m, p) => (p.t > m ? p.t : m), 0);
  return newest >= cutoff;
}

// ─── Disk-full ETA forecast ───────────────────────────────────────────────────

// Hourly average disk_percent per server. The window and device id are clamped
// numbers before they reach Flux (same as serverHistoryHandler.js).
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

// Disk-full ETA for every server with data (or one, if deviceId is given), soonest
// first; servers with no ETA sink to the bottom. Forecasts every volume
// (`server_volumes`) and shows the one filling first, matching disk alerts, which
// use the worst volume. Servers with only older root-only data use `disk_percent`.
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
          // Kept per volume so the forecast report can list every partition with its own
          // recommendation, not only the headline's.
          advice: v.advice,
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
  // Display name first, like the Servers page (§14). A NULL device_id is a room-level
  // environment alert, which has no device row.
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

// ─── Metric registry ───────────────────────────────────
// Same names as alert_rules.metric_name, mapped to their InfluxDB source. `gas` =
// the worse of the MQ-2 sensors, as in sensorHandler.js. `bounded` caps a
// percentage at 100 for threshold suggestions; absent = unbounded (°C / ppm).
const METRICS = {
  cpu:  { source: "server", field: "cpu_percent",  unit: "%",   label: "CPU",         bounded: 100 },
  mem:  { source: "server", field: "mem_percent",  unit: "%",   label: "Memory",      bounded: 100 },
  disk: { source: "server", field: "disk_percent", unit: "%",   label: "Disk",        bounded: 100 },
  temperature: { source: "env", field: "temperature", unit: "°C", label: "Temperature" },
  humidity:    { source: "env", field: "humidity",    unit: "%",  label: "Humidity"   },
  gas:         { source: "env", field: "__gas__",     unit: "ppm", label: "Gas"       },
  // Router/MikroTik metrics (router_metrics; MikroTik fills CPU/mem/clients).
  // recommend:false leaves them out of threshold recommendations; they still get
  // trends and anomalies.
  router_cpu:     { source: "router", field: "cpu_percent",       unit: "%", label: "MikroTik CPU",     bounded: 100, recommend: false },
  router_mem:     { source: "router", field: "mem_percent",       unit: "%", label: "MikroTik Memory",  bounded: 100, recommend: false },
  router_clients: { source: "router", field: "connected_clients", unit: "",  label: "MikroTik Clients", recommend: false },
  // ICMP link quality, available on every router, and the only numeric metrics a
  // ping-only router has. Latency is `recommend: "scoped"`: the right value depends
  // on the link (<1 ms for a rack switch, ~30 ms for ISP equipment), so it is
  // recommended per device, from that link's own p95/p99.
  router_latency: { source: "router", field: "latency_ms", unit: "ms", label: "Latency", recommend: "scoped" },
  // Loss needs no recommendation: 0% is healthy on every link, and the seeded 5/20
  // rule already fits. Trend and anomaly still apply.
  router_loss: { source: "router", field: "packet_loss_pct", unit: "%", label: "Packet Loss", bounded: 100, recommend: false },
};
export function metricMeta(metric) {
  return Object.prototype.hasOwnProperty.call(METRICS, metric) ? METRICS[metric] : null;
}

// ─── Generic series fetch ─────────────────────────────────────────────────────
// Returns sorted [{ t: epochMs, y }]. rangeExpr ("-48h"/"-14d") and every
// ("15m"/"1h") are built from clamped numbers, never raw user input.
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

// Trend and projection for one metric. EWMA smooths the history for display; the
// projection is Holt's method with the daily shape removed and added back
// (analyticsMath.forecastSeasonal). A straight-line projection was badly wrong for
// room temperature over 12h because it ignored the day/night cycle. The default
// lookback is several days so the daily shape can be estimated.
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

  // Do not project from a window that cannot support it. The history is still
  // returned, but `projection` is empty and `dataQuality` says what is missing,
  // rather than silently showing a straight-line guess.
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

  // Does the projection cross an alert threshold within the horizon? Uses the
  // metric's effective alert_rules (">" rules; all these metrics alarm on high).
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

// ─── Anomaly detection (per-hour-of-day z-score + global IQR) ─────────
// Flags readings that are unusual for their hour, e.g. a 2 AM CPU spike still under
// the static threshold. Baseline = mean/σ per local hour bucket; |z| > zThresh is an
// anomaly. Global IQR fences are returned for context.
// A bucket needs this many samples before its baseline is used (at 14 days and 15m
// sampling there are about 40 weekday and 16 weekend samples per bucket).
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

  // Baseline per (day type, hour): 48 buckets, weekday 0-23 then weekend 24-47.
  // See analyticsMath.baselineBucket.
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

// ─── Threshold recommendations (percentiles vs current rules) ─────────
// Suggests warning = p95 and critical = p99 of the history, compared with the
// current global alert_rules, so an admin can tune out false alarms. Server
// metrics pool all servers.
function roundForUnit(v, meta) {
  if (v == null) return null;
  if (meta.unit === "%") return Math.min(meta.bounded ?? 100, Math.round(v));
  if (meta.unit === "°C") return round1(v);
  return Math.round(v); // ppm
}

// `deviceId` limits the suggestion to one device, compared with that device's
// effective rules (its own override, else the global). Useful when servers are not
// alike: a busy and an idle server share a p95 that suits neither.
async function recommendThresholds({ lookbackDays = 14, deviceId = null } = {}) {
  const days = clampInt(lookbackDays, 1, 90, 14);
  const scoped = deviceId != null;

  // When scoped, the device's type decides which metrics apply, so a router is not
  // asked for cpu/mem/disk and does not show "insufficient data" rows.
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
    // `recommend: "scoped"` metrics only make sense per device (see router_latency).
    const scopedOnly = meta.recommend === "scoped";
    if (scopedOnly && !scoped) continue;
    // Environment metrics are room-level, so a scoped request skips them. Otherwise the
    // metric must belong to the scoped device's type.
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
// Measures how right past forecasts were using existing history. See
// analyticsMath.backtestSeries. Reported per device, with the number of folds shown.
async function forecastAccuracy({ metric = "disk", deviceId = null, lookbackDays = 30, horizonDays = 7, folds = 5 } = {}) {
  const meta = METRICS[metric];
  if (!meta) return null;
  const days = clampInt(lookbackDays, 2, 365, 30);
  const horizon = clampNum(horizonDays, 0.25, 90, 7);
  const foldCount = clampInt(folds, 1, 20, 5);
  const horizonMs = horizon * 86_400_000;

  const results = [];
  if (metric === "disk") {
    // Grade the same series the disk forecast shows (the fastest-filling volume, via
    // worstVolumeForecast), not root `disk_percent`.
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

// ─── UPS battery degradation + link saturation ───────────────────
// Same regression as the disk ETA, projected down to a runtime floor (battery
// ageing) or up to a utilization ceiling (link saturation). See
// predictive-analytics.md §8.

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

// UPS battery degradation: regress runtime_remaining_min down to a floor, giving
// "replace battery in ~N days". Runtime also depends on load, so the R² gate filters
// noisy results. upsBatteryStatus (RFC 1628) is the UPS's own verdict and is stored
// by writeUpsMetrics.
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
    // The UPS's own "low"/"depleted" status overrides the regression when it is worse.
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

// Current port labels from MySQL (network_interfaces.location_label), not the Influx
// tag, which is fixed at write time. Grouping stays on interface_name so a relabel
// does not split a port's history.
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

// Link saturation: regress utilization_pct up to a ceiling, giving "uplink hits
// 90% in ~N days". On the MikroTik each port is a building, so both the label and
// the port name are returned.
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
