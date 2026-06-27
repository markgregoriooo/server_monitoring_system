import fs from "fs";
import path from "path";
import db from "../config/mysql.js";
import { queryClient, bucket } from "../config/influx.js";
import { toCSV, toPDFBuffer } from "./reportRenderer.js";

// Real reports: persisted in MySQL `reports`, with a CSV + PDF written to disk per
// report (file_path = stem, the route appends .csv/.pdf). Data is built on generate
// from the live stores — InfluxDB (sensor_environment / server_metrics) and MySQL
// (alerts / aircon_logs) — then frozen into the saved files. Replaces the old
// data/db.js mock array.

const REPORTS_DIR = path.resolve(process.cwd(), "reports");
fs.mkdirSync(REPORTS_DIR, { recursive: true });

export const REPORT_TYPES = ["environment", "server", "alerts", "aircon"];
const TYPE_LABEL = {
  environment: "Environment",
  server: "Server Metrics",
  alerts: "Alert History",
  aircon: "Aircon Activity",
};

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

const num = (v, d = 1) => (typeof v === "number" && !Number.isNaN(v) ? +v.toFixed(d) : null);
const dayKey = (iso) => String(iso).slice(0, 10);

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
    s.avgTemp = num(r.temperature);
    s.avgHum = num(r.humidity, 0);
  }
  for (const r of maxes) {
    const s = slot(dayKey(r._time));
    s.maxTemp = num(r.temperature);
    s.maxGas = num(Math.max(r.mq2_1_ppm ?? 0, r.mq2_2_ppm ?? 0), 0);
  }
  for (const r of mins) {
    const s = slot(dayKey(r._time));
    s.minTemp = num(r.temperature);
  }

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
      { label: "Peak gas", value: Number.isFinite(peakGas) ? `${peakGas} ppm` : "—" },
    ],
    table: {
      columns: ["Date", "Avg Temp °C", "Max Temp °C", "Min Temp °C", "Avg Hum %", "Peak Gas ppm"],
      rows: days.map((d) => [
        d.date, d.avgTemp ?? "—", d.maxTemp ?? "—", d.minTemp ?? "—", d.avgHum ?? "—", d.maxGas ?? "—",
      ]),
    },
  };
}

async function buildServer(start, stop) {
  const fields = `r._field == "cpu_percent" or r._field == "mem_percent" or r._field == "disk_percent"`;
  const q = (fn) => `
    from(bucket: "${bucket}")
      |> range(start: ${start.toISOString()}, stop: ${stop.toISOString()})
      |> filter(fn: (r) => r._measurement == "server_metrics")
      |> filter(fn: (r) => ${fields})
      |> group(columns: ["device_id", "_field"])
      |> ${fn}()`;

  const [means, maxes] = await Promise.all([fluxRows(q("mean")), fluxRows(q("max"))]);

  const byDev = new Map();
  const slot = (id) => {
    if (!byDev.has(id)) byDev.set(id, { device_id: id });
    return byDev.get(id);
  };
  const F = { cpu_percent: "Cpu", mem_percent: "Mem", disk_percent: "Disk" };
  for (const r of means) slot(r.device_id)[`avg${F[r._field]}`] = num(r._value, 0);
  for (const r of maxes) slot(r.device_id)[`max${F[r._field]}`] = num(r._value, 0);

  // Resolve device_id → name from MySQL.
  const [devices] = await db.query(
    "SELECT device_id, device_name FROM devices WHERE device_type = 'server'",
  );
  const nameOf = new Map(devices.map((d) => [String(d.device_id), d.device_name]));

  const rows = [...byDev.values()].sort((a, b) =>
    String(nameOf.get(a.device_id) ?? a.device_id).localeCompare(
      String(nameOf.get(b.device_id) ?? b.device_id),
    ),
  );

  return {
    summary: [
      { label: "Servers reporting", value: rows.length },
      {
        label: "Busiest CPU (avg)",
        value: rows.length
          ? `${nameOf.get(rows.reduce((m, r) => ((r.avgCpu ?? 0) > (m.avgCpu ?? 0) ? r : m)).device_id) ?? "?"}`
          : "—",
      },
    ],
    table: {
      columns: ["Server", "Avg CPU %", "Max CPU %", "Avg Mem %", "Max Mem %", "Avg Disk %", "Max Disk %"],
      rows: rows.map((r) => [
        nameOf.get(r.device_id) ?? `#${r.device_id}`,
        r.avgCpu ?? "—", r.maxCpu ?? "—", r.avgMem ?? "—", r.maxMem ?? "—", r.avgDisk ?? "—", r.maxDisk ?? "—",
      ]),
    },
  };
}

async function buildAlerts(start, stop) {
  const [rows] = await db.query(
    `SELECT a.created_at, a.type, a.title, a.severity, a.status, a.metric_value, d.device_name
       FROM alerts a
       LEFT JOIN devices d ON d.device_id = a.device_id
      WHERE a.created_at BETWEEN ? AND ?
      ORDER BY a.created_at DESC`,
    [start, stop],
  );
  const count = (sev) => rows.filter((r) => r.severity === sev).length;
  return {
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

async function buildAircon(start, stop) {
  const [rows] = await db.query(
    `SELECT l.created_at, l.action, l.reason, l.trigger_type, d.device_name, u.name AS user_name
       FROM aircon_logs l
       LEFT JOIN devices d ON d.device_id = l.device_id
       LEFT JOIN users u   ON u.user_id   = l.user_id
      WHERE l.created_at BETWEEN ? AND ?
      ORDER BY l.created_at DESC`,
    [start, stop],
  );
  const manual = rows.filter((r) => r.trigger_type === "manual").length;
  return {
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

function fmtRow(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? "" : dt.toISOString().replace("T", " ").slice(0, 19);
}

const BUILDERS = {
  environment: buildEnvironment,
  server: buildServer,
  alerts: buildAlerts,
  aircon: buildAircon,
};

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
    periodStart: iso(r.period_start),
    periodEnd: iso(r.period_end),
    createdAt: iso(r.created_at),
    hasFile: !!r.file_path,
  };
}

const BASE_SELECT = `
  SELECT r.report_id, r.title, r.type, r.status, r.generated_by, r.file_path,
         r.period_start, r.period_end, r.created_at, u.name AS generated_by_name
    FROM reports r
    LEFT JOIN users u ON u.user_id = r.generated_by`;

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

async function generate({ userId, type, title, periodStart, periodEnd }) {
  if (!REPORT_TYPES.includes(type)) {
    const err = new Error("Invalid report type.");
    err.status = 400;
    throw err;
  }

  const end = periodEnd ? new Date(periodEnd) : new Date();
  const start = periodStart ? new Date(periodStart) : new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    const err = new Error("Invalid period: start must be before end.");
    err.status = 400;
    throw err;
  }

  const finalTitle = (title && title.trim()) || `${TYPE_LABEL[type]} Report`;

  // Insert as pending first so a slow/failed build is still recorded.
  const [ins] = await db.query(
    `INSERT INTO reports (generated_by, title, type, status, period_start, period_end)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
    [userId, finalTitle.slice(0, 100), type, start, end],
  );
  const id = ins.insertId;

  try {
    const payload = await BUILDERS[type](start, end);
    const report = {
      title: finalTitle,
      type: TYPE_LABEL[type],
      periodStart: start,
      periodEnd: end,
      generatedAt: new Date(),
      summary: payload.summary,
      table: payload.table,
    };

    const stem = `report-${id}`;
    fs.writeFileSync(path.join(REPORTS_DIR, `${stem}.csv`), toCSV(report), "utf8");
    fs.writeFileSync(path.join(REPORTS_DIR, `${stem}.pdf`), await toPDFBuffer(report));

    await db.query(
      "UPDATE reports SET status = 'generated', file_path = ? WHERE report_id = ?",
      [stem, id],
    );
  } catch (err) {
    console.error("[REPORTS] generate failed:", err.message);
    await db.query("UPDATE reports SET status = 'failed' WHERE report_id = ?", [id]);
    const e = new Error("Report generation failed while gathering data.");
    e.status = 500;
    throw e;
  }

  return toClient(await getRaw(id));
}

// Resolve the on-disk file for a download. Returns { absPath, downloadName } or null.
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
  return { absPath, downloadName: `${safeTitle}${period}.${fmt}` };
}

async function remove(id) {
  const row = await getRaw(id);
  if (!row) return false;
  if (row.file_path) {
    for (const fmt of ["csv", "pdf"]) {
      const p = path.join(REPORTS_DIR, `${path.basename(row.file_path)}.${fmt}`);
      try {
        if (p.startsWith(REPORTS_DIR) && fs.existsSync(p)) fs.unlinkSync(p);
      } catch { /* best-effort cleanup */ }
    }
  }
  await db.query("DELETE FROM reports WHERE report_id = ?", [id]);
  return true;
}

export default { list, generate, fileFor, remove, REPORT_TYPES };
