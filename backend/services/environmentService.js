import db from "../config/mysql.js";
import { queryClient, bucket } from "../config/influx.js";

// ─── Environment daily summary (from InfluxDB) ─────────────────────────────
// Per UTC day: average/max/min temperature, average humidity, peak gas (the worse
// MQ-2, like sensorHandler) and the number of environment alerts that day.
//
// Days are UTC because aggregateWindow(every: 1d) buckets in UTC (08:00–08:00
// local). The MySQL alert counts are bucketed in UTC too so the columns line up.
// This is metric history; historyService.js is the audit trail.

// Room-level alert types (no device row). Keep in sync with sensorHandler's
// ENV_METRICS; `esp32_offline` comes from esp32Monitor.
const ENV_ALERT_TYPES = ["temperature", "gas", "humidity", "esp32_offline"];

const FIELDS = ["temperature", "humidity", "mq2_1_ppm", "mq2_2_ppm"];

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function utcDay(iso) {
  return String(iso).slice(0, 10); // Influx _time is ISO-8601 UTC → "YYYY-MM-DD"
}

function round(v, dp = 1) {
  if (typeof v !== "number" || Number.isNaN(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

// One aggregation (mean | max | min) over all four fields per day. `days` is a
// clamped integer, so no user text reaches the query.
function dailyQuery(days, fn) {
  const filter = FIELDS.map((f) => `r._field == "${f}"`).join(" or ");
  return `
    from(bucket: "${bucket}")
      |> range(start: -${days}d)
      |> filter(fn: (r) => r._measurement == "sensor_environment")
      |> filter(fn: (r) => ${filter})
      |> aggregateWindow(every: 1d, fn: ${fn}, timeSrc: "_start", createEmpty: false)
      |> keep(columns: ["_time", "_field", "_value"])
  `;
}

// → Promise<Map<"YYYY-MM-DD", { [field]: number }>>
function runDaily(days, fn) {
  return new Promise((resolve, reject) => {
    const byDay = new Map();
    queryClient.queryRows(dailyQuery(days, fn), {
      next(row, tableMeta) {
        const d = tableMeta.toObject(row);
        if (typeof d._value !== "number") return;
        const day = utcDay(d._time);
        if (!byDay.has(day)) byDay.set(day, {});
        byDay.get(day)[d._field] = d._value;
      },
      error: reject,
      complete: () => resolve(byDay),
    });
  });
}

// Environment alerts per UTC day. Bucketed in JS from epoch seconds so the day
// boundaries line up exactly with the InfluxDB windows (see the header note).
async function eventsByDay(days) {
  const placeholders = ENV_ALERT_TYPES.map(() => "?").join(", ");
  const [rows] = await db.query(
    `SELECT UNIX_TIMESTAMP(created_at) AS ts
       FROM alerts
      WHERE type IN (${placeholders})
        AND created_at >= (NOW() - INTERVAL ${days} DAY)`,
    ENV_ALERT_TYPES,
  );

  const counts = new Map();
  for (const r of rows) {
    const ts = Number(r.ts);
    if (!Number.isFinite(ts)) continue;
    const day = new Date(ts * 1000).toISOString().slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return counts;
}

// Daily rows, newest first. Days with no sensor data are omitted rather than
// zero-filled — an empty row would read as "0 °C", not "the sensor was down".
async function getDailySummary({ days } = {}) {
  const n = clampInt(days, 1, 90, 7);

  const [means, maxes, mins, events] = await Promise.all([
    runDaily(n, "mean"),
    runDaily(n, "max"),
    runDaily(n, "min"),
    eventsByDay(n),
  ]);

  const rows = [...means.keys()].sort().reverse().map((date) => {
    const mean = means.get(date) ?? {};
    const max = maxes.get(date) ?? {};
    const min = mins.get(date) ?? {};

    // Peak gas = the worse of the two MQ-2 sensors, matching the alerting path.
    const gasCandidates = [max.mq2_1_ppm, max.mq2_2_ppm].filter(
      (v) => typeof v === "number",
    );

    return {
      date,
      avgTemp: round(mean.temperature),
      maxTemp: round(max.temperature),
      minTemp: round(min.temperature),
      avgHum: mean.humidity == null ? null : Math.round(mean.humidity),
      peakGas: gasCandidates.length ? Math.round(Math.max(...gasCandidates)) : null,
      events: events.get(date) ?? 0,
    };
  });

  return { logs: rows, days: n };
}

export default { getDailySummary };
