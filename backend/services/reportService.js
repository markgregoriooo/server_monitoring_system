import fs from "fs";
import path from "path";
import db from "../config/mysql.js";
import { BACKEND_ROOT } from "../config/env.js";
import { queryClient, bucket } from "../config/influx.js";
import { toCSV, toPDFBuffer } from "./reportRenderer.js";
import { HttpError, unavailable } from "../utils/httpError.js";
import emailService from "./emailService.js";
import gasSensorService from "./gasSensorService.js";
import analyticsService from "./analyticsService.js";
import {
  REPORT_TYPES,
  TYPE_LABEL,
  SCOPE_TYPES,
  defaultTitle,
  titleWithReference,
  assertBuildersComplete,
} from "./reportTypes.js";
import { computeAvailability, formatDuration } from "./availabilityMath.js";
import {
  formatPH,
  philippineYear,
  referenceNo,
  normalizePaperSize,
  PAPER_SIZE_KEYS,
  resolveSignatories,
} from "./reportTemplate.js";
import brandingService from "./reportBrandingService.js";
import { describeError } from "../utils/httpError.js";

// Reports: a row in MySQL `reports` plus a CSV and a PDF on disk (file_path is the
// stem; the route adds .csv/.pdf). Built from InfluxDB (sensor_environment,
// server_metrics, router_metrics + network_traffic, ups_metrics) and MySQL (alerts,
// aircon_logs) at generate time, then saved.
//
// A new report type must also be added to the `reports.type` ENUM; otherwise MySQL
// in non-strict mode stores '' and the build fails without a clear reason
// (`forecast` was added by migrations/2026-08-09_report_forecast_type.sql).
//
// Device names use COALESCE(NULLIF(display_name, ''), device_name), like the rest
// of the app, aliased back to `device_name`.

// Relative to the backend folder, not process.cwd(). See config/env.js BACKEND_ROOT.
const REPORTS_DIR = path.resolve(BACKEND_ROOT, "reports");

// Widest period one report may cover, in days. Override with REPORT_MAX_PERIOD_DAYS.
const MAX_PERIOD_DAYS = Number(process.env.REPORT_MAX_PERIOD_DAYS) || 366;
fs.mkdirSync(REPORTS_DIR, { recursive: true });

// Set once in init() so status changes can be pushed to browsers. Reports are
// shared (everyone sees every report), so the three lifecycle events go to every
// dashboard. Only the toast is for the creator; the page checks `generatedBy`
// (see Reports.tsx).
let _io = null;
function init(io) {
  _io = io;
  // Fire-and-forget, like the build it cleans up after.
  failStuckBuilds().catch((e) => console.error("[reports] stuck-build sweep failed:", e.message));
}

/**
 * Mark `pending` rows that can no longer be building. A restart during a build
 * leaves its row pending forever (build() runs in the background), so any report
 * still pending after 15 minutes is marked failed. Runs once at startup.
 * See audits/design-patterns-report-2026-08-25.md (P-11).
 */
async function failStuckBuilds() {
  const [r] = await db.query(
    `UPDATE reports
        SET status = 'failed'
      WHERE status = 'pending'
        AND created_at < (NOW() - INTERVAL 15 MINUTE)`,
  );
  if (r.affectedRows) {
    console.warn(`[reports] marked ${r.affectedRows} stuck build(s) failed (orphaned by a restart)`);
  }
  return r.affectedRows;
}

// Type list, labels and scopes all come from ./reportTypes.js — one registry row per
// report type instead of four parallel maps that had to be kept in step by hand.
export { REPORT_TYPES } from "./reportTypes.js";

function badRequest(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

// The only user-supplied value that goes into a Flux query. It must be a positive
// integer here, and create() also validates it and stores it in an INT column.
function fluxDeviceFilter(deviceId) {
  if (deviceId == null) return "";
  const id = Number(deviceId);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("Invalid device id.");
  return `|> filter(fn: (r) => r.device_id == "${id}")`;
}

// ─── Influx helper ──────────────────────────────────────────────────────────
// Whitelisted Flux only (no user strings interpolated) → no injection surface.
function fluxRows(flux) {
  return new Promise((resolve, reject) => {
    const out = [];
    queryClient.queryRows(flux, {
      next(row, tableMeta) {
        out.push(tableMeta.toObject(row));
      },
      error: reject,
      complete() {
        resolve(out);
      },
    });
  });
}

// Rounds to `d` decimals, or null when the value is not a real number — report
// cells show a blank rather than NaN. N-03.
const roundOrNull = (v, d = 1) => (typeof v === "number" && !Number.isNaN(v) ? +v.toFixed(d) : null);
const dayKey = (iso) => String(iso).slice(0, 10);
// "2026-08-21" -> "Aug 21". Short enough to sit under a bar without overlapping its
// neighbour, and unambiguous inside a period the header already names.
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const dayLabel = (key) => {
  const [, m, d] = String(key).split("-");
  return m && d ? `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}` : String(key);
};

/**
 * Count rows per day of the period, by category. Empty days are included, so a
 * chart does not squeeze out quiet days.
 */
function dailyCounts(rows, start, stop, categoryOf, timeOf = (r) => r.created_at) {
  const days = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(stop);
  // Guard against a period so wide it would produce thousands of bars.
  while (cursor <= end && days.length < 120) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
  const index = new Map(days.map((d, i) => [d, i]));
  const buckets = new Map();
  for (const r of rows) {
    const cat = categoryOf(r);
    if (!cat) continue;
    const i = index.get(dayKey(new Date(timeOf(r)).toISOString()));
    if (i === undefined) continue;
    if (!buckets.has(cat)) buckets.set(cat, new Array(days.length).fill(0));
    buckets.get(cat)[i] += 1;
  }
  return { labels: days.map(dayLabel), buckets };
}
// Decimal GB, the convention for link throughput (not GiB).
const gb = (bytes) => +((Number(bytes) || 0) / 1e9).toFixed(2);

/**
 * A time-bucketed series for a chart, from InfluxDB. The tables summarise the whole
 * period; a trend line needs it split into buckets.
 *
 * `fn: mean` across the matching devices: exact for one device, the campus average
 * otherwise. `createEmpty: false` leaves a gap where nothing was recorded, and
 * chartMath.segments breaks the line there.
 *
 * @returns {Promise<{labels: string[], byField: Map<string, (number|null)[]>}>}
 */
async function fluxTimeSeries(measurement, fieldFilter, start, stop, scope, points = 30) {
  const spanMs = stop.getTime() - start.getTime();
  // At least a minute per bucket — 30 points over a short window would otherwise ask
  // Influx for sub-second aggregation and return noise.
  const everySec = Math.max(60, Math.round(spanMs / points / 1000));
  const rows = await fluxRows(`
    from(bucket: "${bucket}")
      |> range(start: ${start.toISOString()}, stop: ${stop.toISOString()})
      |> filter(fn: (r) => r._measurement == "${measurement}")
      ${scope}
      |> filter(fn: (r) => ${fieldFilter})
      |> group(columns: ["_field"])
      |> aggregateWindow(every: ${everySec}s, fn: mean, createEmpty: false)`);

  // One column per distinct timestamp, so every field lines up on the same x axis even
  // when one of them stopped reporting partway through.
  const times = [...new Set(rows.map((r) => r._time))].sort();
  const index = new Map(times.map((t, i) => [t, i]));
  const byField = new Map();
  for (const r of rows) {
    if (!byField.has(r._field)) byField.set(r._field, new Array(times.length).fill(null));
    const v = Number(r._value);
    byField.get(r._field)[index.get(r._time)] = Number.isFinite(v) ? +v.toFixed(2) : null;
  }

  // A day is label enough for a multi-day report; a 24-hour one needs the clock.
  const byDay = spanMs > 3 * 86_400_000;
  const labels = times.map((t) => {
    const d = new Date(t);
    return byDay
      ? dayLabel(d.toISOString().slice(0, 10))
      : formatPH(d, { seconds: false }).slice(11, 16);
  });
  return { labels, byField };
}

// ─── Data builders (return the normalized report payload) ────────────────────
async function buildEnvironment(start, stop) {
  const fields = `r._field == "temperature" or r._field == "humidity" or r._field == "mq2_1_ppm" or r._field == "mq2_2_ppm"`;
  const q = (fn) => `
    from(bucket: "${bucket}")
      |> range(start: ${start.toISOString()}, stop: ${stop.toISOString()})
      |> filter(fn: (r) => r._measurement == "sensor_environment")
      |> filter(fn: (r) => ${fields})
      |> aggregateWindow(every: 1d, fn: ${fn}, timeSrc: "_start", createEmpty: false)
      |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")`;

  const [means, maxes, mins] = await Promise.all([
    fluxRows(q("mean")),
    fluxRows(q("max")),
    fluxRows(q("min")),
  ]);

  const byDay = new Map();
  const slot = (d) => {
    if (!byDay.has(d)) byDay.set(d, { date: d });
    return byDay.get(d);
  };
  for (const r of means) {
    const s = slot(dayKey(r._time));
    s.avgTemp = roundOrNull(r.temperature);
    s.avgHum = roundOrNull(r.humidity, 0);
  }
  for (const r of maxes) {
    const s = slot(dayKey(r._time));
    s.maxTemp = roundOrNull(r.temperature);
    s.maxGas = roundOrNull(Math.max(r.mq2_1_ppm ?? 0, r.mq2_2_ppm ?? 0), 0);
  }
  for (const r of mins) {
    const s = slot(dayKey(r._time));
    s.minTemp = roundOrNull(r.temperature);
  }

  /* ── Per-sensor gas ────────────────────────────────────────────────────────────────
     Shows which sensor saw the peak, so the reader knows where in the room it was.
     Read from `sensor_gas` (per channel), so sensors 3 and 4 are included; names come
     from MySQL. A period from before the per-sensor series has no rows, and the
     report uses the aggregate table above as before. */
  const perSensor = await fluxRows(`
    from(bucket: "${bucket}")
      |> range(start: ${start.toISOString()}, stop: ${stop.toISOString()})
      |> filter(fn: (r) => r._measurement == "sensor_gas" and r._field == "ppm")
      |> group(columns: ["channel"])`);

  const sensorStats = new Map();
  for (const r of perSensor) {
    const ch = Number(r.channel);
    if (!Number.isFinite(ch) || r._value == null) continue;
    const st = sensorStats.get(ch) ?? { channel: ch, peak: -Infinity, sum: 0, n: 0 };
    if (r._value > st.peak) st.peak = r._value;
    st.sum += r._value;
    st.n += 1;
    sensorStats.set(ch, st);
  }
  const sensors = [...sensorStats.values()]
    .sort((a, b) => a.channel - b.channel)
    .map((st) => ({
      channel: st.channel,
      label: gasSensorService.labelFor(st.channel),
      peak: Math.round(st.peak),
      avg: Math.round(st.sum / st.n),
    }));
  // WHERE the worst reading of the whole period came from.
  const worstSensor = sensors.reduce((m, s2) => (m && m.peak >= s2.peak ? m : s2), null);

  const days = [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date));
  const temps = days.map((d) => d.avgTemp).filter((v) => v != null);
  const overallAvg = temps.length ? +(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : null;
  const peakTemp = days.reduce((m, d) => (d.maxTemp != null && d.maxTemp > m ? d.maxTemp : m), -Infinity);
  const peakGas = days.reduce((m, d) => (d.maxGas != null && d.maxGas > m ? d.maxGas : m), -Infinity);

  return {
    summary: [
      { label: "Days covered", value: days.length },
      { label: "Avg temperature", value: overallAvg != null ? `${overallAvg} °C` : "—" },
      { label: "Peak temperature", value: Number.isFinite(peakTemp) ? `${peakTemp} °C` : "—" },
      {
        label: "Peak gas",
        value: Number.isFinite(peakGas)
          ? `${peakGas} ppm${worstSensor ? ` · ${worstSensor.label}` : ""}`
          : "—",
      },
    ],
    // Ascending for the chart — the table is newest-first, but a time axis that ran
    // backwards would be read wrong by everyone.
    charts: (() => {
      const asc = [...days].reverse();
      if (!asc.length) return [];
      const labels = asc.map((d) => dayLabel(d.date));
      return [
        {
          // Temperature and humidity share one 0-100 axis: both live in that range, and
          // it is the pairing ICTU asked for ("Temperature / Humidity").
          title: "Temperature (°C) and humidity (%)",
          kind: "line", max: 100, labels,
          series: [
            { name: "Avg temp °C", color: "#EF9F27", values: asc.map((d) => d.avgTemp ?? null) },
            { name: "Avg humidity %", color: "#38BDF8", values: asc.map((d) => d.avgHum ?? null) },
          ],
        },
        {
          // Gas is ppm — its own axis, or a 300ppm smoke event would be invisible
          // against a 0-100 scale.
          title: "Peak gas (ppm)",
          kind: "line", labels,
          series: [{ name: "Peak gas", color: "#F472B6", values: asc.map((d) => d.maxGas ?? null) }],
        },
      ];
    })(),
    // Two tables: the daily readings, and which sensor produced them. Left out when the
    // period has no per-sensor data.
    tables: [
      {
        title: "Daily readings",
        columns: ["Date", "Avg Temp °C", "Max Temp °C", "Min Temp °C", "Avg Hum %", "Peak Gas ppm"],
        rows: days.map((d) => [
          d.date, d.avgTemp ?? "—", d.maxTemp ?? "—", d.minTemp ?? "—", d.avgHum ?? "—", d.maxGas ?? "—",
        ]),
      },
      ...(sensors.length
        ? [{
            title: "Smoke sensors monitored",
            columns: ["Sensor", "Location", "Peak ppm", "Avg ppm"],
            rows: sensors.map((s2) => [`MQ2-${s2.channel}`, s2.label, s2.peak, s2.avg]),
          }]
        : []),
    ],
  };
}

// Follows ICTU's outline (reports-client-questionnaire.md): identity header, then
// Server Availability, then Resource Utilization.
async function buildServer(start, stop, deviceId) {
  const S = start.toISOString();
  const E = stop.toISOString();
  const scope = fluxDeviceFilter(deviceId);

  const gauges = (fn) => `
    from(bucket: "${bucket}")
      |> range(start: ${S}, stop: ${E})
      |> filter(fn: (r) => r._measurement == "server_metrics")
      ${scope}
      |> filter(fn: (r) =>
          r._field == "cpu_percent" or r._field == "mem_percent" or r._field == "disk_percent")
      |> group(columns: ["device_id", "_field"])
      |> ${fn}()`;

  // net_bytes_sent/recv are cumulative counters (bytes since boot, from gopsutil), so
  // they are not averaged. increase() sums the non-negative deltas (a reboot counts
  // as 0) and last() gives the period total, like buildNetwork does for SNMP counters.
  const counters = `
    from(bucket: "${bucket}")
      |> range(start: ${S}, stop: ${E})
      |> filter(fn: (r) => r._measurement == "server_metrics")
      ${scope}
      |> filter(fn: (r) => r._field == "net_bytes_sent" or r._field == "net_bytes_recv")
      |> group(columns: ["device_id", "_field"])
      |> increase()
      |> last()`;

  const scoped = deviceId != null;

  // `server_specs` is a LEFT JOIN: a server enrolled before its first host refresh has
  // no specs row and must still appear.
  const [devices] = await db.query(
    `SELECT d.device_id,
            COALESCE(NULLIF(d.display_name, ''), d.device_name) AS device_name,
            d.ip_address, d.location, d.status,
            s.os, s.kernel, s.architecture, s.cores, s.memory_total_mb
       FROM devices d
       LEFT JOIN server_specs s ON s.device_id = d.device_id
      WHERE d.device_type = 'server'${scoped ? " AND d.device_id = ?" : ""}`,
    scoped ? [deviceId] : [],
  );

  // Offline incidents overlapping the window. An overlap test, not BETWEEN, so an
  // outage that started before the period still counts.
  // Servers raise type='offline' (agentService); routers/UPS/MikroTik raise
  // 'device_offline' (deviceAlerts), so this also filters by device_type.
  const [outageRows] = await db.query(
    `SELECT a.device_id, a.created_at, a.resolved_at
       FROM alerts a
       JOIN devices d ON d.device_id = a.device_id
      WHERE a.type = 'offline'
        AND d.device_type = 'server'
        AND a.created_at < ?
        AND (a.resolved_at IS NULL OR a.resolved_at > ?)
        ${scoped ? "AND a.device_id = ?" : ""}
      ORDER BY a.created_at`,
    scoped ? [stop, start, deviceId] : [stop, start],
  );

  const [means, maxes, ctrs, trend] = await Promise.all([
    fluxRows(gauges("mean")),
    fluxRows(gauges("max")),
    fluxRows(counters),
    fluxTimeSeries(
      "server_metrics",
      `r._field == "cpu_percent" or r._field == "mem_percent" or r._field == "disk_percent"`,
      start, stop, scope,
    ),
  ]);

  const byDev = new Map();
  const slot = (id) => {
    if (!byDev.has(id)) byDev.set(id, { device_id: id, sentBytes: 0, recvBytes: 0 });
    return byDev.get(id);
  };
  const F = { cpu_percent: "Cpu", mem_percent: "Mem", disk_percent: "Disk" };
  for (const r of means) slot(r.device_id)[`avg${F[r._field]}`] = roundOrNull(r._value, 0);
  for (const r of maxes) slot(r.device_id)[`max${F[r._field]}`] = roundOrNull(r._value, 0);
  for (const r of ctrs) {
    const d = slot(r.device_id);
    if (r._field === "net_bytes_sent") d.sentBytes = Number(r._value) || 0;
    else d.recvBytes = Number(r._value) || 0;
  }

  // A registered server that reported NOTHING in the period still belongs in the
  // report — "no data" is the finding. Influx alone would omit it silently.
  for (const d of devices) slot(String(d.device_id));

  const meta = new Map(devices.map((d) => [String(d.device_id), d]));

  // Drop device_ids that are in InfluxDB but no longer in MySQL. Deleting a server
  // keeps its history, so an unscoped report would otherwise print removed servers
  // as "#53 — — —". The number of dropped devices is reported.
  const orphaned = [...byDev.keys()].filter((id) => !meta.has(id));
  for (const id of orphaned) byDev.delete(id);
  const nameOf = (id) => meta.get(id)?.device_name ?? `#${id}`;
  // On Windows the OS string already contains the kernel version, so each part is only
  // added when it is not already there (on Linux they differ: "ubuntu 22.04" /
  // "5.15.0-187-generic").
  // devices.status (online/offline/warning/maintenance), title-cased; "—" when the row
  // is gone from MySQL.
  const statusOf = (id) => {
    const v = meta.get(id)?.status;
    return v ? v.charAt(0).toUpperCase() + v.slice(1) : "—";
  };
  const osOf = (id) => {
    const m = meta.get(id);
    if (!m?.os) return "—";
    const detail = [m.kernel, m.architecture]
      .filter((part) => part && !m.os.includes(part))
      .join(", ");
    return detail ? `${m.os} (${detail})` : m.os;
  };

  // Availability per device from the merged outage windows (see availabilityMath).
  // Not the agent's uptime_seconds, which resets on reboot.
  const outagesByDev = new Map();
  for (const r of outageRows) {
    const key = String(r.device_id);
    if (!outagesByDev.has(key)) outagesByDev.set(key, []);
    outagesByDev.get(key).push({ createdAt: r.created_at, resolvedAt: r.resolved_at });
  }
  const availOf = new Map();
  for (const id of byDev.keys()) {
    availOf.set(
      id,
      computeAvailability({
        periodStart: start,
        periodEnd: stop,
        outages: outagesByDev.get(id) ?? [],
      }),
    );
  }

  const rows = [...byDev.values()].sort((a, b) =>
    nameOf(a.device_id).localeCompare(nameOf(b.device_id)),
  );

  // ── Headline figures ──
  const totalIncidents = rows.reduce((s, r) => s + (availOf.get(r.device_id)?.incidents ?? 0), 0);
  const totalDowntime = rows.reduce((s, r) => s + (availOf.get(r.device_id)?.downtimeSec ?? 0), 0);
  // The overall figure is the worst server, not the average, so one server that was
  // down for a day is not hidden by healthy ones.
  const worst = rows.reduce(
    (m, r) => {
      const a = availOf.get(r.device_id);
      return a?.availabilityPct != null && (m == null || a.availabilityPct < m.pct)
        ? { pct: a.availabilityPct, id: r.device_id }
        : m;
    },
    /** @type {{pct: number, id: string}|null} */ (null),
  );

  const summary = [
    { label: "Servers reporting", value: rows.length },
    {
      label: "Lowest availability",
      value: worst ? `${nameOf(worst.id)} — ${worst.pct}%` : "—",
    },
    { label: "Total downtime", value: formatDuration(totalDowntime) },
    { label: "Incidents", value: totalIncidents },
    {
      label: "Busiest CPU (avg)",
      value: rows.length
        ? nameOf(rows.reduce((m, r) => ((r.avgCpu ?? 0) > (m.avgCpu ?? 0) ? r : m)).device_id)
        : "—",
    },
  ];

  // Stated only when it happened, so a normal report carries no line about it.
  if (orphaned.length) {
    summary.push({
      label: "Excluded",
      value: `${orphaned.length} removed ${orphaned.length === 1 ? "server" : "servers"} with data in this period (no longer registered)`,
    });
  }

  const tables = [];

  // ── Server identity ──
  // For one server the identity is a header (`meta`, shown under the title), as ICTU
  // drew it. For all servers the same fields become the first table.
  const identity = scoped
    ? [
        { label: "Server Name", value: nameOf(String(deviceId)) },
        { label: "IP Address", value: meta.get(String(deviceId))?.ip_address || "—" },
        { label: "Operating System", value: osOf(String(deviceId)) },
        { label: "Status (now)", value: statusOf(String(deviceId)) },
      ]
    : [];

  if (!scoped) {
    tables.push({
      title: "Servers Monitored",
      // "Status (now)" is the current status, not the status during the period, so it is
      // labelled that way. The period figure is in the Availability section.
      columns: ["Server", "IP Address", "Operating System", "Location", "Status (now)"],
      rows: rows.map((r) => [
        nameOf(r.device_id),
        meta.get(r.device_id)?.ip_address || "—",
        osOf(r.device_id),
        meta.get(r.device_id)?.location || "—",
        statusOf(r.device_id),
      ]),
    });
  }

  // ── Server Availability ──
  tables.push({
    title: "Server Availability",
    columns: ["Server", "Uptime", "Downtime", "Availability %", "Incidents"],
    rows: rows.map((r) => {
      const a = availOf.get(r.device_id);
      return [
        nameOf(r.device_id),
        a ? formatDuration(a.uptimeSec) : "—",
        a ? formatDuration(a.downtimeSec) : "—",
        a?.availabilityPct ?? "—",
        a?.incidents ?? "—",
      ];
    }),
  });

  // ── Resource Utilization ──
  // Disk is included even though ICTU listed only CPU/Memory/Network; it is already
  // collected and alerted on.
  tables.push({
    title: "Resource Utilization",
    columns: [
      "Server", "Avg CPU %", "Max CPU %", "Avg Mem %", "Max Mem %",
      "Avg Disk %", "Max Disk %", "Net Sent GB", "Net Recv GB",
    ],
    rows: rows.map((r) => [
      nameOf(r.device_id),
      r.avgCpu ?? "—", r.maxCpu ?? "—", r.avgMem ?? "—", r.maxMem ?? "—",
      r.avgDisk ?? "—", r.maxDisk ?? "—",
      // A server with no counter delta (one sample, or none) reads "—" rather than
      // "0 GB" — nothing measured is not the same as nothing transferred.
      r.sentBytes ? gb(r.sentBytes) : "—",
      r.recvBytes ? gb(r.recvBytes) : "—",
    ]),
  });

  // One chart on one fixed 0-100 axis, using the same colours as the dashboard's
  // ServerFocus chart.
  const charts = trend.labels.length
    ? [{
        title: "Resource utilization over the period (%)",
        kind: "line", max: 100, labels: trend.labels,
        series: [
          { name: "CPU", color: "#378ADD", values: trend.byField.get("cpu_percent") ?? [] },
          { name: "Memory", color: "#7F77DD", values: trend.byField.get("mem_percent") ?? [] },
          { name: "Disk", color: "#EF9F27", values: trend.byField.get("disk_percent") ?? [] },
        ].filter((x) => x.values.length),
      }]
    : [];

  return { meta: identity, summary, tables, charts };
}

// ─── Network: SNMP routers + MikroTik ────────────────────────────────────────
// Both pollers write the same measurements, so one builder covers every network
// device. device_type (SNMP router or MikroTik) is shown as a column.
async function buildNetwork(start, stop, deviceId) {
  const S = start.toISOString();
  const E = stop.toISOString();
  const scope = fluxDeviceFilter(deviceId);

  // Per-device gauges (same group()+aggregate shape as buildServer).
  const gauges = (fn) => `
    from(bucket: "${bucket}")
      |> range(start: ${S}, stop: ${E})
      |> filter(fn: (r) => r._measurement == "router_metrics")
      ${scope}
      |> filter(fn: (r) =>
          r._field == "cpu_percent" or r._field == "mem_percent" or
          r._field == "connected_clients" or
          // ICMP. These are the ONLY numbers a ping-only router has, so without
          // them its report row was blank in every column — a device that had been
          // polled all month appeared never to have reported at all.
          r._field == "latency_ms" or r._field == "packet_loss_pct")
      |> group(columns: ["device_id", "_field"])
      |> ${fn}()`;

  // Byte/error counters are cumulative, so no mean: increase() sums the non-negative
  // deltas (a reboot counts as 0) and last() takes the period total. A single sample
  // has no delta and gives no row.
  const counters = `
    from(bucket: "${bucket}")
      |> range(start: ${S}, stop: ${E})
      |> filter(fn: (r) => r._measurement == "network_traffic")
      ${scope}
      |> filter(fn: (r) => r._field == "rx_bytes" or r._field == "tx_bytes" or r._field == "rx_errors" or r._field == "tx_errors")
      |> increase()
      |> last()`;

  const peakUtil = `
    from(bucket: "${bucket}")
      |> range(start: ${S}, stop: ${E})
      |> filter(fn: (r) => r._measurement == "network_traffic")
      ${scope}
      |> filter(fn: (r) => r._field == "utilization_pct")
      |> max()`;

  // link_up is a boolean → map to 1/0 so mean() reads as "share of polls the port
  // was up".
  const linkUp = `
    from(bucket: "${bucket}")
      |> range(start: ${S}, stop: ${E})
      |> filter(fn: (r) => r._measurement == "network_traffic")
      ${scope}
      |> filter(fn: (r) => r._field == "link_up")
      |> map(fn: (r) => ({ r with _value: if r._value then 1.0 else 0.0 }))
      |> mean()`;

  const [means, maxes, ctrs, utils, links, trend] = await Promise.all([
    fluxRows(gauges("mean")),
    fluxRows(gauges("max")),
    fluxRows(counters),
    fluxRows(peakUtil),
    fluxRows(linkUp),
    // router_metrics, because latency and loss exist for every router, including
    // ping-only ones.
    fluxTimeSeries(
      "router_metrics",
      `r._field == "latency_ms" or r._field == "packet_loss_pct"`,
      start, stop, scope,
    ),
  ]);

  // Device facts + offline events from MySQL. `scoped` narrows both to one device
  // when the report is device-scoped (bound param, not interpolated).
  const scoped = deviceId != null;
  // `ping_only` marks a router monitored by ICMP alone (no SNMP community, e.g. ISP
  // equipment). It never has CPU, memory, clients or interfaces, so those columns
  // are not shown as blanks for it.
  const [devices] = await db.query(
    `SELECT d.device_id,
            COALESCE(NULLIF(d.display_name, ''), d.device_name) AS device_name,
            d.device_type, d.location,
            (n.snmp_community IS NULL OR n.snmp_community = '') AS ping_only
       FROM devices d
       LEFT JOIN device_network n ON n.device_id = d.device_id
      WHERE d.device_type IN ('router', 'mikrotik')${scoped ? " AND d.device_id = ?" : ""}`,
    scoped ? [deviceId] : [],
  );
  const [offline] = await db.query(
    `SELECT a.device_id, COUNT(*) AS n
       FROM alerts a
       JOIN devices d ON d.device_id = a.device_id
      WHERE a.type = 'device_offline'
        AND d.device_type IN ('router', 'mikrotik')
        AND a.created_at BETWEEN ? AND ?
        ${scoped ? "AND a.device_id = ?" : ""}
      GROUP BY a.device_id`,
    scoped ? [start, stop, deviceId] : [start, stop],
  );
  const meta = new Map(devices.map((d) => [String(d.device_id), d]));
  const offlineOf = new Map(offline.map((r) => [String(r.device_id), Number(r.n)]));

  // ── Per-device roll-up ──
  const byDev = new Map();
  const dev = (id) => {
    if (!byDev.has(id)) byDev.set(id, { device_id: id, rxBytes: 0, txBytes: 0 });
    return byDev.get(id);
  };
  const G = {
    cpu_percent: "Cpu", mem_percent: "Mem", connected_clients: "Clients",
    latency_ms: "Latency", packet_loss_pct: "Loss",
  };
  for (const r of means) dev(r.device_id)[`avg${G[r._field]}`] = roundOrNull(r._value, 0);
  for (const r of maxes) dev(r.device_id)[`max${G[r._field]}`] = roundOrNull(r._value, 0);

  // ── Per-interface breakdown ──
  const byIface = new Map();
  const iface = (r) => {
    const key = `${r.device_id}|${r.interface_name}`;
    if (!byIface.has(key)) {
      byIface.set(key, {
        device_id: r.device_id,
        name: r.interface_name || "—",
        label: r.location_label || "",
        rxBytes: 0, txBytes: 0, errors: 0,
      });
    }
    return byIface.get(key);
  };
  for (const r of ctrs) {
    const i = iface(r);
    const v = Number(r._value) || 0;
    if (r._field === "rx_bytes") { i.rxBytes = v; dev(r.device_id).rxBytes += v; }
    else if (r._field === "tx_bytes") { i.txBytes = v; dev(r.device_id).txBytes += v; }
    else i.errors += v; // rx_errors + tx_errors — one "did this link misbehave" number
  }
  for (const r of utils) iface(r).peakUtil = roundOrNull(r._value, 0);
  for (const r of links) iface(r).upPct = roundOrNull(Number(r._value) * 100, 0);

  // Same orphan rule as buildServer: routers removed from MySQL are dropped from both
  // tables, along with their interface rows.
  const orphaned = [...byDev.keys()].filter((id) => !meta.has(id));
  for (const id of orphaned) byDev.delete(id);
  for (const [key, i] of [...byIface.entries()]) {
    if (!meta.has(i.device_id)) byIface.delete(key);
  }

  const nameOf = (id) => meta.get(id)?.device_name ?? `#${id}`;
  const kindOf = (id) => {
    const t = meta.get(id)?.device_type;
    return t === "mikrotik" ? "MikroTik" : t === "router" ? "Router" : "—";
  };

  const devRows = [...byDev.values()].sort((a, b) =>
    nameOf(a.device_id).localeCompare(nameOf(b.device_id)),
  );
  const ifaceRows = [...byIface.values()].sort(
    (a, b) => b.rxBytes + b.txBytes - (a.rxBytes + a.txBytes),
  );

  const totalBytes = devRows.reduce((s, d) => s + d.rxBytes + d.txBytes, 0);
  const totalErrors = ifaceRows.reduce((s, i) => s + i.errors, 0);
  const totalOffline = devRows.reduce((s, d) => s + (offlineOf.get(d.device_id) ?? 0), 0);
  const busiest = ifaceRows[0];

  // ── Is this report only about ping-only devices? ──
  // If so, leave out the SNMP columns and the Ports section. Decided from the devices
  // in the report, so a mixed campus-wide report keeps the full layout.
  const icmpOnly =
    devRows.length > 0 && devRows.every((d) => Number(meta.get(d.device_id)?.ping_only) === 1);

  const summary = [{ label: "Network devices reporting", value: devRows.length }];
  if (!icmpOnly) {
    summary.push(
      { label: "Total traffic", value: totalBytes ? `${gb(totalBytes)} GB` : "—" },
      {
        label: "Busiest port",
        value: busiest
          ? `${nameOf(busiest.device_id)} ${busiest.name}${busiest.label ? ` (${busiest.label})` : ""} — ${gb(busiest.rxBytes + busiest.txBytes)} GB`
          : "—",
      },
      { label: "Link errors", value: totalErrors },
    );
  }
  summary.push(
    // Worst packet loss in the period; the key figure for a ping-only WAN router.
    {
      label: "Worst packet loss",
      value: (() => {
        const withLoss = devRows.filter((d) => d.maxLoss != null);
        if (!withLoss.length) return "—";
        const worst = withLoss.reduce((a, b) => (b.maxLoss > a.maxLoss ? b : a));
        return `${nameOf(worst.device_id)} — ${worst.maxLoss}%`;
      })(),
    },
    { label: "Offline events", value: totalOffline },
  );

  const tables = [
    icmpOnly
      ? {
          // Reachability only (what ICMP can measure) plus the outage count. Loss shows both
          // average and worst, since the average alone hides a spike.
          title: "Reachability",
          columns: ["Device", "Device Type", "Avg ms", "Max ms", "Avg Loss %", "Max Loss %", "Offline"],
          rows: devRows.map((d) => [
            nameOf(d.device_id), kindOf(d.device_id),
            d.avgLatency ?? "—", d.maxLatency ?? "—",
            d.avgLoss ?? "—", d.maxLoss ?? "—",
            offlineOf.get(d.device_id) ?? 0,
          ]),
        }
      : {
          title: "Devices",
          // Latency (avg/max) and average loss sit beside the SNMP columns, so it is still one
          // row per device. "—" means not reported, as for CPU on a ping-only router.
          columns: ["Device", "Device Type", "Avg CPU %", "Max CPU %", "Avg Mem %", "Avg Clients", "Avg ms", "Max ms", "Avg Loss %", "RX GB", "TX GB", "Offline"],
          rows: devRows.map((d) => [
            nameOf(d.device_id), kindOf(d.device_id),
            d.avgCpu ?? "—", d.maxCpu ?? "—", d.avgMem ?? "—", d.avgClients ?? "—",
            d.avgLatency ?? "—", d.maxLatency ?? "—", d.avgLoss ?? "—",
            gb(d.rxBytes), gb(d.txBytes), offlineOf.get(d.device_id) ?? 0,
          ]),
        },
  ];

  // A ping-only device has no interfaces to report on — ever. "Ports / No data for the
  // selected period" invites someone to go looking for a poller fault that isn't there.
  if (!icmpOnly) {
    tables.push({
      title: "Ports",
      columns: ["Device", "Port", "Location", "RX GB", "TX GB", "Peak Util %", "Errors", "Link Up %"],
      rows: ifaceRows.map((i) => [
        nameOf(i.device_id), i.name, i.label || "—",
        gb(i.rxBytes), gb(i.txBytes),
        i.peakUtil ?? "—", i.errors, i.upPct ?? "—",
      ]),
    });
  }

  // Two charts, not one: milliseconds and percent cannot share an axis without one of
  // them becoming a flat line along the bottom.
  const charts = [];
  const latency = trend.byField.get("latency_ms");
  const loss = trend.byField.get("packet_loss_pct");
  if (latency?.length) {
    charts.push({
      title: "Round-trip latency (ms)",
      kind: "line", labels: trend.labels,
      series: [{ name: "Latency", color: "#378ADD", values: latency }],
    });
  }
  if (loss?.length) {
    charts.push({
      // Pinned 0-100 so a healthy link is a flat line on the floor rather than noise
      // magnified to fill the box.
      title: "Packet loss (%)",
      kind: "line", max: 100, labels: trend.labels,
      series: [{ name: "Loss", color: "#E02F44", values: loss }],
    });
  }

  return { summary, tables, charts };
}

// ─── UPS power ───────────────────────────────────────────────────────────────
async function buildUps(start, stop, deviceId) {
  const S = start.toISOString();
  const E = stop.toISOString();
  const scope = fluxDeviceFilter(deviceId);

  const gauges = (fn) => `
    from(bucket: "${bucket}")
      |> range(start: ${S}, stop: ${E})
      |> filter(fn: (r) => r._measurement == "ups_metrics")
      ${scope}
      |> filter(fn: (r) =>
          r._field == "battery_charge_pct" or r._field == "runtime_remaining_min" or
          r._field == "load_pct" or r._field == "input_voltage" or
          r._field == "output_voltage" or r._field == "battery_voltage" or
          r._field == "temperature")
      |> group(columns: ["device_id", "_field"])
      |> ${fn}()`;

  // on_battery is a boolean, so this reports the share of polls spent on battery,
  // which does not depend on the poll interval. The event count comes from alerts.
  const onBattery = `
    from(bucket: "${bucket}")
      |> range(start: ${S}, stop: ${E})
      |> filter(fn: (r) => r._measurement == "ups_metrics")
      ${scope}
      |> filter(fn: (r) => r._field == "on_battery")
      |> map(fn: (r) => ({ r with _value: if r._value then 1.0 else 0.0 }))
      |> group(columns: ["device_id"])
      |> mean()`;

  const [means, mins, maxes, batt, trend] = await Promise.all([
    fluxRows(gauges("mean")),
    fluxRows(gauges("min")),
    fluxRows(gauges("max")),
    fluxRows(onBattery),
    fluxTimeSeries(
      "ups_metrics",
      `r._field == "battery_charge_pct" or r._field == "runtime_remaining_min" or r._field == "load_pct"`,
      start, stop, scope,
    ),
  ]);

  // Charge and load are percentages and share an axis; runtime is MINUTES and gets its
  // own, or a 40-minute runtime would sit off the top of a 0-100 scale.
  const upsCharts = [];
  const charge = trend.byField.get("battery_charge_pct");
  const load = trend.byField.get("load_pct");
  const runtime = trend.byField.get("runtime_remaining_min");
  if (charge?.length || load?.length) {
    upsCharts.push({
      title: "Battery charge and load (%)",
      kind: "line", max: 100, labels: trend.labels,
      series: [
        { name: "Charge", color: "#73BF69", values: charge ?? [] },
        { name: "Load", color: "#EF9F27", values: load ?? [] },
      ].filter((x) => x.values.length),
    });
  }
  if (runtime?.length) {
    upsCharts.push({
      // The figure that actually answers "how long do we have" — the one a UPS report
      // exists for.
      title: "Runtime remaining (minutes)",
      kind: "line", labels: trend.labels,
      series: [{ name: "Runtime", color: "#B877D9", values: runtime }],
    });
  }

  const scoped = deviceId != null;
  const [devices] = await db.query(
    `SELECT device_id, COALESCE(NULLIF(display_name, ''), device_name) AS device_name, location FROM devices
      WHERE device_type = 'ups'${scoped ? " AND device_id = ?" : ""}`,
    scoped ? [deviceId] : [],
  );
  const [events] = await db.query(
    `SELECT a.device_id, a.type, COUNT(*) AS n
       FROM alerts a
       JOIN devices d ON d.device_id = a.device_id
      WHERE a.type IN ('ups_on_battery', 'device_offline')
        AND d.device_type = 'ups'
        AND a.created_at BETWEEN ? AND ?
        ${scoped ? "AND a.device_id = ?" : ""}
      GROUP BY a.device_id, a.type`,
    scoped ? [start, stop, deviceId] : [start, stop],
  );
  const meta = new Map(devices.map((d) => [String(d.device_id), d]));
  const evOf = new Map();
  for (const e of events) {
    const slot = evOf.get(String(e.device_id)) ?? { ups_on_battery: 0, device_offline: 0 };
    slot[e.type] = Number(e.n);
    evOf.set(String(e.device_id), slot);
  }

  const byDev = new Map();
  const dev = (id) => {
    if (!byDev.has(id)) byDev.set(id, { device_id: id });
    return byDev.get(id);
  };
  const F = {
    battery_charge_pct: "Charge",
    runtime_remaining_min: "Runtime",
    load_pct: "Load",
    input_voltage: "InV",
    output_voltage: "OutV",
    battery_voltage: "BattV",
    temperature: "Temp",
  };
  for (const r of means) dev(r.device_id)[`avg${F[r._field]}`] = roundOrNull(r._value, 0);
  for (const r of mins) dev(r.device_id)[`min${F[r._field]}`] = roundOrNull(r._value, 0);
  for (const r of maxes) dev(r.device_id)[`max${F[r._field]}`] = roundOrNull(r._value, 0);
  for (const r of batt) dev(r.device_id).onBattPct = roundOrNull(Number(r._value) * 100, 1);

  const nameOf = (id) => meta.get(id)?.device_name ?? `#${id}`;
  const rows = [...byDev.values()].sort((a, b) =>
    nameOf(a.device_id).localeCompare(nameOf(b.device_id)),
  );

  const lowest = (key) =>
    rows.reduce((m, r) => (r[key] != null && (m == null || r[key] < m) ? r[key] : m), null);
  const totalEv = (type) =>
    rows.reduce((s, r) => s + (evOf.get(r.device_id)?.[type] ?? 0), 0);
  const peakLoad = rows.reduce((m, r) => (r.maxLoad != null && r.maxLoad > m ? r.maxLoad : m), -Infinity);

  return {
    charts: upsCharts,
    summary: [
      { label: "UPS units reporting", value: rows.length },
      { label: "Lowest battery", value: lowest("minCharge") != null ? `${lowest("minCharge")} %` : "—" },
      { label: "Shortest runtime", value: lowest("minRuntime") != null ? `${lowest("minRuntime")} min` : "—" },
      { label: "Peak load", value: Number.isFinite(peakLoad) ? `${peakLoad} %` : "—" },
      { label: "On-battery events", value: totalEv("ups_on_battery") },
      { label: "Offline events", value: totalEv("device_offline") },
    ],
    tables: [
      {
        title: "Battery & load",
        columns: ["UPS", "Location", "Avg Charge %", "Min Charge %", "Avg Runtime min", "Min Runtime min", "Avg Load %", "Max Load %", "On Battery %"],
        rows: rows.map((r) => [
          nameOf(r.device_id), meta.get(r.device_id)?.location ?? "—",
          r.avgCharge ?? "—", r.minCharge ?? "—",
          r.avgRuntime ?? "—", r.minRuntime ?? "—",
          r.avgLoad ?? "—", r.maxLoad ?? "—", r.onBattPct ?? "—",
        ]),
      },
      {
        title: "Voltage & events",
        columns: ["UPS", "Avg Input V", "Min Input V", "Max Input V", "Avg Output V", "Avg Battery V", "Max Temp °C", "On-battery", "Offline"],
        rows: rows.map((r) => [
          nameOf(r.device_id),
          r.avgInV ?? "—", r.minInV ?? "—", r.maxInV ?? "—",
          r.avgOutV ?? "—", r.avgBattV ?? "—", r.maxTemp ?? "—",
          evOf.get(r.device_id)?.ups_on_battery ?? 0,
          evOf.get(r.device_id)?.device_offline ?? 0,
        ]),
      },
    ],
  };
}

async function buildAlerts(start, stop, deviceId, scopeKind = null) {
  const scoped = deviceId != null;
  // Room scope means no device: environment alerts have deviceId null
  // (sensorHandler.js), so it is `device_id IS NULL` and needs its own branch.
  const roomOnly = scopeKind === ROOM_SCOPE;
  const where = scoped ? "AND a.device_id = ?" : roomOnly ? "AND a.device_id IS NULL" : "";
  const [rows] = await db.query(
    `SELECT a.created_at, a.type, a.title, a.severity, a.status, a.metric_value,
            COALESCE(NULLIF(d.display_name, ''), d.device_name) AS device_name
       FROM alerts a
       LEFT JOIN devices d ON d.device_id = a.device_id
      WHERE a.created_at BETWEEN ? AND ?
        ${where}
      ORDER BY a.created_at DESC`,
    scoped ? [start, stop, deviceId] : [start, stop],
  );
  const count = (sev) => rows.filter((r) => r.severity === sev).length;
  const daily = dailyCounts(rows, start, stop, (r) => r.severity);
  return {
    // Severity order is fixed (critical first) rather than whatever the data happened to
    // contain, so the same colour means the same thing on every report.
    charts: rows.length
      ? [{
          title: "Alerts per day, by severity",
          kind: "bar",
          labels: daily.labels,
          series: ["critical", "warning", "info"]
            .filter((sev) => daily.buckets.has(sev))
            .map((sev) => ({
              name: sev,
              color: { critical: "#E02F44", warning: "#FF780A", info: "#5794F2" }[sev],
              values: daily.buckets.get(sev),
            })),
        }]
      : [],
    summary: [
      { label: "Total alerts", value: rows.length },
      { label: "Critical", value: count("critical") },
      { label: "Warning", value: count("warning") },
      { label: "Info", value: count("info") },
    ],
    table: {
      columns: ["Time", "Severity", "Device", "Title", "Value", "Status"],
      rows: rows.map((r) => [
        fmtRow(r.created_at),
        r.severity,
        r.device_name ?? "Server room",
        r.title,
        r.metric_value ?? "—",
        r.status,
      ]),
    },
  };
}

async function buildAircon(start, stop, deviceId) {
  const scoped = deviceId != null;
  const [rows] = await db.query(
    `SELECT l.created_at, l.action, l.reason, l.trigger_type, u.name AS user_name,
            COALESCE(NULLIF(d.display_name, ''), d.device_name) AS device_name
       FROM aircon_logs l
       LEFT JOIN devices d ON d.device_id = l.device_id
       LEFT JOIN users u   ON u.user_id   = l.user_id
      WHERE l.created_at BETWEEN ? AND ?
        ${scoped ? "AND l.device_id = ?" : ""}
      ORDER BY l.created_at DESC`,
    scoped ? [start, stop, deviceId] : [start, stop],
  );
  const manual = rows.filter((r) => r.trigger_type === "manual").length;
  const daily = dailyCounts(rows, start, stop, (r) => r.trigger_type);
  return {
    // Manual vs auto is the question this report exists to answer — who acted, and how
    // often the room cooled itself.
    charts: rows.length
      ? [{
          title: "Aircon actions per day",
          kind: "bar",
          labels: daily.labels,
          series: ["manual", "auto"]
            .filter((t) => daily.buckets.has(t))
            .map((t) => ({
              name: t,
              color: { manual: "#3CC8E8", auto: "#73BF69" }[t],
              values: daily.buckets.get(t),
            })),
        }]
      : [],
    summary: [
      { label: "Total actions", value: rows.length },
      { label: "Manual", value: manual },
      { label: "Auto", value: rows.length - manual },
    ],
    table: {
      columns: ["Time", "Unit", "Action", "Trigger", "By", "Reason"],
      rows: rows.map((r) => [
        fmtRow(r.created_at),
        r.device_name ?? "—",
        r.action,
        r.trigger_type,
        r.user_name ?? (r.trigger_type === "auto" ? "system" : "—"),
        r.reason,
      ]),
    },
  };
}

// ─── Forecast report ──────────────────────────────────────────────────────────
// The only forward-looking report: the period is the lookback, and the report shows
// what is projected next (e.g. "this volume fills in three weeks"). Forecast accuracy
// is included so the projection comes with its track record.
// See predictive-analytics.md §17.
async function buildForecast(start, stop, deviceId) {
  const spanDaysReq = Math.max(
    2,
    Math.round((new Date(stop).getTime() - new Date(start).getTime()) / 86_400_000),
  );

  const [disks, upses, links, accuracy] = await Promise.all([
    analyticsService.forecastDiskFull({ deviceId, lookbackDays: spanDaysReq }),
    analyticsService.forecastUpsBattery({ deviceId, lookbackDays: spanDaysReq }),
    analyticsService.forecastLinkSaturation({ deviceId, lookbackDays: spanDaysReq }),
    analyticsService.forecastAccuracy({ metric: "disk", deviceId, lookbackDays: spanDaysReq, horizonDays: 7 }),
  ]);

  const dated = (etaDays) =>
    etaDays == null ? "—" : new Date(Date.now() + etaDays * 86_400_000).toISOString().slice(0, 10);
  const eta = (v) => (v == null ? "—" : `${v} d`);
  const acting = [...disks, ...upses, ...links].filter((r) => r.advice);

  const tables = [
    {
      title: "Disk capacity",
      columns: ["Server", "Volume", "Current %", "Trend %/day", "ETA", "Projected full", "Confidence", "History d"],
      rows: disks.map((d) => [
        d.name, d.mount ?? "—", d.currentPercent ?? "—", d.slopePerDay ?? "—",
        d.status === "filling" ? eta(d.etaDays) : d.status,
        d.status === "filling" ? dated(d.etaDays) : "—",
        d.confidence, d.historyDays,
      ]),
    },
    {
      title: "UPS battery",
      columns: ["UPS", "Runtime min", "Trend min/day", "ETA to floor", "Replace by", "Confidence", "History d"],
      rows: upses.map((u) => [
        u.name, u.currentRuntimeMin ?? "—", u.slopePerDay ?? "—",
        u.status === "declining" ? eta(u.etaDays) : u.status,
        u.status === "declining" ? dated(u.etaDays) : "—",
        u.confidence, u.historyDays,
      ]),
    },
    {
      title: "Link saturation",
      columns: ["Device", "Interface", "Current %", "Trend %/day", "ETA", "Saturates by", "Confidence", "History d"],
      rows: links.map((l) => [
        l.name, l.interfaceLabel ? `${l.interfaceLabel} (${l.interface})` : l.interface,
        l.currentUtil ?? "—", l.slopePerDay ?? "—",
        l.status === "rising" ? eta(l.etaDays) : l.status,
        l.status === "rising" ? dated(l.etaDays) : "—",
        l.confidence, l.historyDays,
      ]),
    },
  ];

  if (acting.length) {
    tables.push({
      title: "Action needed",
      columns: ["Severity", "Recommendation"],
      rows: acting.map((r) => [r.advice.level, r.advice.message]),
    });
  }

  if (accuracy?.status === "ok") {
    tables.push({
      title: `Forecast accuracy (backtested, ${accuracy.horizonDays}-day horizon)`,
      columns: ["Server", "Typical miss", "Bias", "Worst miss", "Predictions checked"],
      rows: accuracy.devices.filter((d) => d.folds > 0).map((d) => [
        d.name, `±${d.mae}${accuracy.unit}`,
        `${(d.bias ?? 0) > 0 ? "over" : (d.bias ?? 0) < 0 ? "under" : "even"} ${Math.abs(d.bias ?? 0)}${accuracy.unit}`,
        `±${d.worst}${accuracy.unit}`, d.folds,
      ]),
    });
  }

  return {
    summary: [
      { label: "Lookback used", value: `${spanDaysReq} days` },
      { label: "Volumes projected to fill", value: disks.filter((d) => d.status === "filling").length },
      { label: "UPS batteries declining", value: upses.filter((u) => u.status === "declining").length },
      { label: "Interfaces trending up", value: links.filter((l) => l.status === "rising").length },
      { label: "Items needing action", value: acting.length },
      {
        label: "Forecast accuracy",
        value: accuracy?.overallMae == null ? "not yet verifiable" : `±${accuracy.overallMae}${accuracy.unit}`,
      },
    ],
    tables,
  };
}

function fmtRow(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? "" : dt.toISOString().replace("T", " ").slice(0, 19);
}

const BUILDERS = {
  environment: buildEnvironment,
  server: buildServer,
  network: buildNetwork,
  ups: buildUps,
  alerts: buildAlerts,
  aircon: buildAircon,
  forecast: buildForecast,
};

// Fail at startup if the registry and the builders do not match, instead of a
// report quietly failing later.
assertBuildersComplete(BUILDERS);

// ─── Client shaping ──────────────────────────────────────────────────────────
function toClient(r) {
  const iso = (v) => (v instanceof Date ? v.toISOString() : v);
  return {
    id: r.report_id,
    title: r.title,
    type: r.type,
    status: r.status,
    generatedBy: r.generated_by,
    generatedByName: r.generated_by_name ?? null,
    // null = campus-wide. deviceName survives as NULL if the device is later
    // deleted (FK is ON DELETE SET NULL) — the report itself is still valid history.
    deviceId: r.device_id ?? null,
    deviceName: r.device_name ?? null,
    // 'room' = the server room itself. Orthogonal to deviceId, never both: the room is
    // not a `devices` row, so it cannot be expressed as one.
    scopeKind: r.scope_kind ?? null,
    scopeName: r.scope_kind === ROOM_SCOPE ? ROOM_SCOPE_LABEL : (r.device_name ?? null),
    periodStart: iso(r.period_start),
    periodEnd: iso(r.period_end),
    createdAt: iso(r.created_at),
    // Assigned during build(), so it is null while a row is pending and stays null on
    // one that failed — a number is only spent on a document that exists.
    referenceNo: r.reference_no ?? null,
    paperSize: normalizePaperSize(r.paper_size),
    hasFile: !!r.file_path,
  };
}

// The server room as a scope. reports.device_id is a foreign key to devices, so the
// room is stored in `scope_kind` instead (migration 2026-09-18_report_room_scope.sql).
export const ROOM_SCOPE = "room";
const ROOM_SCOPE_LABEL = "Server Room";

const BASE_SELECT = `
  SELECT r.report_id, r.title, r.type, r.device_id, r.scope_kind, r.status, r.generated_by, r.file_path,
         r.paper_size, r.reference_no,
         r.period_start, r.period_end, r.created_at,
         u.name AS generated_by_name, COALESCE(NULLIF(d.display_name, ''), d.device_name) AS device_name
    FROM reports r
    LEFT JOIN users u   ON u.user_id   = r.generated_by
    LEFT JOIN devices d ON d.device_id = r.device_id`;

// Devices a report of `type` can be limited to. Uses the same SCOPE_TYPES map as the
// check in create(), so the dropdown and the validation always agree. Empty = the
// type is campus-wide.
async function scopeOptions(type) {
  const allowed = SCOPE_TYPES[type];
  if (!allowed?.length) return [];

  // The ESP32 has no devices row, so its option in the alerts scope list is added here.
  const roomOption = allowed.includes("esp32")
    ? [{ id: ROOM_SCOPE, name: `${ROOM_SCOPE_LABEL} (temperature · humidity · gas)`, type: "esp32", location: null }]
    : [];

  const [rows] = await db.query(
    `SELECT device_id, COALESCE(NULLIF(display_name, ''), device_name) AS device_name, device_type, location
       FROM devices
      WHERE device_type IN (${allowed.map(() => "?").join(", ")})
      ORDER BY device_type, device_name`,
    allowed,
  );
  return [
    ...roomOption,
    ...rows.map((d) => ({
      id: d.device_id,
      name: d.device_name,
      type: d.device_type,
      location: d.location ?? null,
    })),
  ];
}

// ─── Public API ──────────────────────────────────────────────────────────────
async function list({ type, limit = 100 } = {}) {
  const n = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const where = [];
  const params = [];
  if (type && REPORT_TYPES.includes(type)) {
    where.push("r.type = ?");
    params.push(type);
  }
  const sql =
    BASE_SELECT +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY r.created_at DESC LIMIT ${n}`;
  const [rows] = await db.query(sql, params);
  return rows.map(toClient);
}

async function getRaw(id) {
  const [[row]] = await db.query(`${BASE_SELECT} WHERE r.report_id = ? LIMIT 1`, [id]);
  return row ?? null;
}

// Generation has two steps so the request does not wait: create() saves a `pending`
// row and returns, build() does the work and sets the status. A crash mid-build
// leaves a visible pending row.

async function create({ userId, type, title, periodStart, periodEnd, deviceId, paperSize }) {
  if (!REPORT_TYPES.includes(type)) throw badRequest("Invalid report type.");

  // Paper size: the caller's choice, else the configured default. Checked strictly,
  // because a typo from a person should be an error, not silently turned into Folio.
  let page;
  if (paperSize == null || paperSize === "") {
    page = await brandingService.defaultPaperSize();
  } else {
    page = String(paperSize).trim().toLowerCase();
    if (!PAPER_SIZE_KEYS.includes(page)) {
      throw badRequest(`Invalid paper size. Choose one of: ${PAPER_SIZE_KEYS.join(", ")}.`);
    }
  }

  const end = periodEnd ? new Date(periodEnd) : new Date();
  const start = periodStart ? new Date(periodStart) : new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    throw badRequest("Invalid period: start must be before end.");
  }

  // Limit the period length. A huge range (e.g. from 2000) would run long queries in
  // the background and write a huge file. A year is longer than anything kept here
  // (alerts 30d, reports 90d, system_logs 365d). Rejected rather than shortened, so
  // the title never claims a different range than the contents.
  // See audits/business-logic-review-2026-08-25.md (BL-05).
  const spanDays = (end.getTime() - start.getTime()) / 86_400_000;
  if (spanDays > MAX_PERIOD_DAYS) {
    throw badRequest(
      `Report period cannot exceed ${MAX_PERIOD_DAYS} days (requested ${Math.round(spanDays)}).`,
    );
  }

  // Device scope is validated here, so later code reads an integer from an INT column.
  // A scope that does not fit the report type is rejected.
  let scopeId = null;
  let scopeName = null;
  let scopeKind = null;
  if (deviceId === ROOM_SCOPE) {
    // Checked against the SAME list a device scope is checked against, so the room can
    // only be asked for on a report type that actually covers room-level rows.
    if (!SCOPE_TYPES[type]?.includes("esp32")) {
      throw badRequest(`A ${TYPE_LABEL[type]} report does not cover the server room's own readings.`);
    }
    scopeKind = ROOM_SCOPE;
    scopeName = ROOM_SCOPE_LABEL;
  } else if (deviceId != null && deviceId !== "") {
    const id = Number(deviceId);
    if (!Number.isInteger(id) || id <= 0) throw badRequest("Invalid device id.");
    const allowed = SCOPE_TYPES[type];
    if (!allowed) throw badRequest(`A ${TYPE_LABEL[type]} report covers the whole server room and cannot be scoped to one device.`);
    const [[dev]] = await db.query(
      "SELECT device_id, COALESCE(NULLIF(display_name, ''), device_name) AS device_name, device_type FROM devices WHERE device_id = ? LIMIT 1",
      [id],
    );
    if (!dev) throw badRequest("Device not found.");
    if (!allowed.includes(dev.device_type)) {
      throw badRequest(`"${dev.device_name}" is a ${dev.device_type}, which a ${TYPE_LABEL[type]} report does not cover.`);
    }
    scopeId = dev.device_id;
    scopeName = dev.device_name;
  }

  // Default title carries the scope, so a list of reports stays readable. build()
  // appends the control number to this once it has one — see stampReference.
  const finalTitle = (title && title.trim()) || defaultTitle(type, scopeName);

  const [ins] = await db.query(
    `INSERT INTO reports (generated_by, title, type, device_id, scope_kind, status, period_start, period_end, paper_size)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [userId, finalTitle.slice(0, 100), type, scopeId, scopeKind, start, end, page],
  );

  const created = toClient(await getRaw(ins.insertId));
  // Announce the pending row so every open Reports page shows it building — not just
  // the tab that asked for it.
  _io?.emit("reportCreated", created);
  return created;
}

// Build the data, write both files and set the status. Never throws (it runs in the
// background); failure is reported through the row status and a `reportUpdated` push.
/**
 * Push the current report template to every open dashboard, so other users'
 * Generate dialogs show the new default paper size. Best-effort: a socket problem
 * must not make a saved change look failed.
 */
async function broadcastTemplate() {
  if (!_io) return;
  try {
    _io.emit("reportTemplateUpdated", await brandingService.describe());
  } catch (err) {
    console.error("[REPORTS] could not broadcast template:", describeError(err));
  }
}

/**
 * Claim this report's control number.
 *
 * ICTU's sample is `ICTU-ENV-2026-001`, so numbering is per (type, year). The year
 * and the count both come from SQL `created_at`, so they use the same clock
 * (Manila); `philippineYear` is only a fallback. Only rows that already have a
 * number are counted, so a failed build leaves no gap.
 *
 * The UNIQUE index on `reference_no` settles races: if two reports get the same
 * number, the second gets ER_DUP_ENTRY and takes the next. Done before any file is
 * written, so a collision only costs a retry.
 */
async function claimReference(row, generatedAt) {
  if (row.reference_no) return row.reference_no;

  for (let attempt = 0; attempt < 5; attempt++) {
    let year = philippineYear(generatedAt);
    let seq = 1;
    try {
      const [[r]] = await db.query(
        `SELECT YEAR(r.created_at) AS yr,
                (SELECT COUNT(*)
                   FROM reports p
                  WHERE p.type = r.type
                    AND YEAR(p.created_at) = YEAR(r.created_at)
                    AND p.reference_no IS NOT NULL
                    AND p.report_id < r.report_id) + 1 AS seq
           FROM reports r
          WHERE r.report_id = ?`,
        [row.report_id],
      );
      if (r?.yr) year = Number(r.yr);
      if (r?.seq) seq = Number(r.seq);
    } catch (err) {
      // A number is worth having but is not worth failing the report over.
      console.error("[REPORTS] reference sequence lookup failed:", err.message);
    }

    const candidate = referenceNo(row.type, year, seq + attempt);
    try {
      await db.query("UPDATE reports SET reference_no = ? WHERE report_id = ?", [
        candidate,
        row.report_id,
      ]);
      return candidate;
    } catch (err) {
      if (err?.code !== "ER_DUP_ENTRY") throw err;
      // Someone took it between the count and the write. Round again.
    }
  }

  // Unique by construction — report_id is the primary key — so the document still
  // carries a citable number even if the sequence could not be resolved.
  return referenceNo(row.type, philippineYear(generatedAt), row.report_id);
}

async function build(id) {
  const row = await getRaw(id);
  if (!row) return null;

  try {
    const start = new Date(row.period_start);
    const end = new Date(row.period_end);
    const payload = await BUILDERS[row.type](start, end, row.device_id ?? null, row.scope_kind ?? null);
    const generatedAt = new Date();

    // The control number is assigned here, and only when the build succeeds, so failed
    // reports use no number. Saved on the row, since ICTU may quote it.
    const reference = await claimReference(row, generatedAt);

    // Logos and page size are read now and saved with the files, so re-downloading an
    // old report gives the same document.
    const [cspcLogo, ictuLogo, unit, sigConfig] = await Promise.all([
      brandingService.logoPath("cspc"),
      brandingService.logoPath("ictu"),
      brandingService.unitName(),
      brandingService.signatories(),
    ]);

    // Decided BEFORE the files are written, so the PDF's own title, the row in the list
    // and the download filename are all the same string.
    const finalTitle = titleWithReference(
      { title: row.title, type: row.type, deviceName: row.device_name },
      reference,
    );

    const report = {
      title: finalTitle,
      referenceNo: reference,
      paperSize: normalizePaperSize(row.paper_size),
      branding: { cspc: cspcLogo, ictu: ictuLogo },
      // The large line on the letterhead. CSPC's own stationery reads "COLLEGE of
      // COMPUTER STUDIES" there; these are ICTU's reports, so it reads ICTU.
      unitName: unit,
      type: TYPE_LABEL[row.type] + (row.device_name ? ` — ${row.device_name}` : ""),
      periodStart: start,
      periodEnd: end,
      generatedAt,
      // The signature block. Lines marked `auto` get the name of whoever generated the
      // report. This replaced a "Responsible" row that repeated "Prepared by".
      // ICTU's list also has "Responsible" among the server fields, which may mean the
      // machine's custodian; that is not recorded yet (see reports-client-questionnaire.md).
      signatories: resolveSignatories(sigConfig, row.generated_by_name || ""),
      // ── Identity block ──
      // Type first, then what the builder knows about the subject (server name / IP / OS),
      // then the period and the creation time.
      meta: [
        { label: "Type", value: TYPE_LABEL[row.type] },
        ...(payload.meta ?? []),
        {
          label: "Monitoring Period",
          value: `${formatPH(start)}  to  ${formatPH(end)}`,
        },
        { label: "Date and Time Created", value: formatPH(generatedAt) },
      ],
      // Vector charts drawn between the summary and the tables. A builder that has
      // nothing worth plotting simply omits them.
      charts: payload.charts ?? [],
      summary: payload.summary,
      // A builder returns either one `table` or several titled `tables` — the
      // renderer normalizes both. Only ever one of the two is set.
      table: payload.table,
      tables: payload.tables,
    };

    const stem = `report-${id}`;
    fs.writeFileSync(path.join(REPORTS_DIR, `${stem}.csv`), toCSV(report), "utf8");
    fs.writeFileSync(path.join(REPORTS_DIR, `${stem}.pdf`), await toPDFBuffer(report));

    await db.query(
      "UPDATE reports SET status = 'generated', file_path = ?, title = ? WHERE report_id = ?",
      [stem, finalTitle, id],
    );
  } catch (err) {
    console.error("[REPORTS] build failed:", describeError(err));
    try {
      await db.query("UPDATE reports SET status = 'failed' WHERE report_id = ?", [id]);
    } catch (dbErr) {
      // The DB is the only channel for "this failed" — if it's down too, log and
      // leave the row pending rather than crash the process.
      console.error("[REPORTS] could not mark failed:", dbErr.message);
    }
  }

  const final = toClient(await getRaw(id));
  if (final) _io?.emit("reportUpdated", final);
  return final;
}

// Create + build in one call. The route uses create/build separately so it can
// answer 202 immediately; this is for callers that genuinely want to wait.
async function generate(opts) {
  const created = await create(opts);
  return (await build(created.id)) ?? created;
}

// Find the file for a download. Returns { absPath, downloadName, report } or null.
// `report` is included so the route can log whose report was exported.
async function fileFor(id, format) {
  const fmt = String(format).toLowerCase();
  if (fmt !== "csv" && fmt !== "pdf") return null;
  const row = await getRaw(id);
  if (!row || !row.file_path || row.status !== "generated") return null;

  const absPath = path.join(REPORTS_DIR, `${path.basename(row.file_path)}.${fmt}`);
  if (!absPath.startsWith(REPORTS_DIR) || !fs.existsSync(absPath)) return null;

  // Download name = "<title> <start> to <end>.<fmt>", sanitized for the filesystem.
  const dateOnly = (d) => {
    const dt = d instanceof Date ? d : new Date(d);
    return Number.isNaN(dt.getTime()) ? "" : dt.toISOString().slice(0, 10);
  };
  const safeTitle = String(row.title || "report").replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").slice(0, 60);
  const period =
    row.period_start && row.period_end
      ? `_${dateOnly(row.period_start)}_to_${dateOnly(row.period_end)}`
      : "";
  return { absPath, downloadName: `${safeTitle}${period}.${fmt}`, report: toClient(row) };
}

// Returns the removed report or null, so the route can log what was deleted.
async function remove(id, { silent = false } = {}) {
  const row = await getRaw(id);
  if (!row) return null;
  if (row.file_path) {
    for (const fmt of ["csv", "pdf"]) {
      const p = path.join(REPORTS_DIR, `${path.basename(row.file_path)}.${fmt}`);
      try {
        if (p.startsWith(REPORTS_DIR) && fs.existsSync(p)) fs.unlinkSync(p);
      } catch { /* best-effort cleanup */ }
    }
  }
  await db.query("DELETE FROM reports WHERE report_id = ?", [id]);
  // Tell other open pages the report is gone. `silent` is for the retention purge.
  if (!silent) _io?.emit("reportDeleted", { id: Number(id) });
  return toClient(row);
}

// Email an already-generated report as a PDF. Separate from generate so resending
// does not rebuild it (the numbers stay as saved). The recipient is the requesting
// user, taken from the database.
async function email(id, { toUserId } = {}) {
  const row = await getRaw(id);
  if (!row) throw badRequest("Report not found.");
  if (row.status !== "generated" || !row.file_path) {
    throw badRequest("Report is not ready to send yet.");
  }
  if (!emailService.isEnabled()) {
    throw unavailable("Email is not configured on this server (SMTP_USER / SMTP_PASS).");
  }

  const [[user]] = await db.query("SELECT email, name FROM users WHERE user_id = ? LIMIT 1", [
    toUserId ?? row.generated_by,
  ]);
  if (!user?.email) throw badRequest("No email address on file for that user.");

  const file = await fileFor(id, "pdf");
  if (!file) throw badRequest("Report PDF is missing — regenerate it.");

  const ok = await emailService.sendReportEmail(
    user.email,
    {
      title: row.title,
      typeLabel: TYPE_LABEL[row.type] ?? row.type,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      deviceName: row.device_name ?? null,
      generatedByName: row.generated_by_name ?? null,
      filename: file.downloadName,
    },
    fs.readFileSync(file.absPath),
  );
  if (!ok) {
    // 502: we reached the provider and it refused. Exposed — an admin needs to know the
    // send failed at the far end rather than in our code.
    throw new HttpError(502, "The email provider rejected the message.", { expose: true });
  }
  // `report` rides along so the route can audit WHAT was sent, not just "#<id>".
  return { sentTo: user.email, report: toClient(row) };
}

// Retention: delete reports older than `days`, row and both files, through remove()
// so there is one delete path. A row without its file would be a broken download.
async function purgeOld(days) {
  // NOT `Number(days) || 90` — 0 is falsy, so that silently turns "purge everything"
  // into "keep 90 days", which is the opposite instruction. 0 is a legitimate value.
  const raw = Number(days);
  const n = Number.isFinite(raw) && raw >= 0 ? raw : 90;
  const [rows] = await db.query(
    "SELECT report_id FROM reports WHERE created_at < (NOW() - INTERVAL ? DAY)",
    [n],
  );
  let removed = 0;
  for (const r of rows) {
    // silent: the nightly purge would otherwise fire one socket event per row at 3am.
    // Nobody is watching, and a page opened later loads the correct list anyway.
    if (await remove(r.report_id, { silent: true })) removed++;
  }
  return removed;
}

export default {
  init, failStuckBuilds, list, create, build, generate, fileFor, remove, purgeOld, scopeOptions, email,
  REPORT_TYPES, SCOPE_TYPES,
  broadcastTemplate,
};
