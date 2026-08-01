// Simulated in-memory database
// In production, replace with MySQL + InfluxDB queries

import bcrypt from "bcryptjs";



// ── SERVERS (simulates MySQL servers table) ───────────────────────────────────
const servers = [
  { id: 1, name: "Server 1", ip: "192.168.1.101", status: "Online", cpu: 35, memory: 54, uptime: "15 days" },
  { id: 2, name: "Server 2", ip: "192.168.1.102", status: "Online", cpu: 52, memory: 67, uptime: "12 days" },
  { id: 3, name: "Server 3", ip: "192.168.1.103", status: "Online", cpu: 28, memory: 49, uptime: "20 days" },
];

// ── SENSOR HISTORY / DAILY AGGREGATES — REMOVED ───────────────────────────────
// `generateSensorHistory()` (random temps) and `historyLogs` (five rows hardcoded to
// March 2025) used to back GET /api/environment/history and /logs. Both are gone:
// daily summaries now come from InfluxDB via services/environmentService.js, and live
// sensor history via the Socket.IO `changeRange` → querySensorHistoryHandler path.

// ── ALERTS ────────────────────────────────────────────────────────────────────
const alerts = [
  { id: 1, type: "warning", title: "High Temperature", desc: "Server Room",     time: "10:32 AM" },
  { id: 2, type: "warning", title: "CPU Usage High",   desc: "Server 2",        time: "09:45 AM" },
  { id: 3, type: "info",    title: "Aircon Turned ON", desc: "Auto Control",    time: "09:30 AM" },
  { id: 4, type: "info",    title: "Server 3 Rebooted",desc: "Scheduled",       time: "08:00 AM" },
];

// ── REPORTS ───────────────────────────────────────────────────────────────────
const reports = [
  { id: 1, title: "Daily Temperature Report", date: "2025-03-12", status: "Generated", type: "Environment" },
  { id: 2, title: "Weekly Server Metrics",    date: "2025-03-10", status: "Generated", type: "Server"      },
  { id: 3, title: "Monthly Uptime Summary",   date: "2025-03-01", status: "Generated", type: "Server"      },
  { id: 4, title: "Alert History Report",     date: "2025-03-12", status: "Pending",   type: "Alerts"      },
];

// ── AUDIT LOG ─────────────────────────────────────────────────────────────────
const auditLog = [];

export {
  servers,
  alerts,
  reports,
  auditLog,
};
