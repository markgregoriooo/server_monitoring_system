// Simulated in-memory database
// In production, replace with MySQL + InfluxDB queries

import bcrypt from "bcryptjs";



// ── SERVERS (simulates MySQL servers table) ───────────────────────────────────
const servers = [
  { id: 1, name: "Server 1", ip: "192.168.1.101", status: "Online", cpu: 35, memory: 54, uptime: "15 days" },
  { id: 2, name: "Server 2", ip: "192.168.1.102", status: "Online", cpu: 52, memory: 67, uptime: "12 days" },
  { id: 3, name: "Server 3", ip: "192.168.1.103", status: "Online", cpu: 28, memory: 49, uptime: "20 days" },
];

// ── SENSOR HISTORY (simulates InfluxDB time-series) ───────────────────────────
function generateSensorHistory(count = 20) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const ts = new Date(now - (count - i) * 60000); // 1 min intervals
    return {
      time: ts.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" }),
      timestamp: ts.toISOString(),
      temperature: +(24 + Math.random() * 4).toFixed(1),
      humidity: Math.round(62 + Math.random() * 12),
    };
  });
}

// ── HISTORY LOGS (simulates InfluxDB daily aggregates) ────────────────────────
const historyLogs = [
  { date: "2025-03-12", avgTemp: 26.2, maxTemp: 28.1, minTemp: 24.0, avgHum: 69, events: 3 },
  { date: "2025-03-11", avgTemp: 25.8, maxTemp: 27.5, minTemp: 23.5, avgHum: 67, events: 1 },
  { date: "2025-03-10", avgTemp: 27.1, maxTemp: 29.0, minTemp: 25.2, avgHum: 72, events: 5 },
  { date: "2025-03-09", avgTemp: 24.9, maxTemp: 26.3, minTemp: 23.1, avgHum: 65, events: 0 },
  { date: "2025-03-08", avgTemp: 26.5, maxTemp: 28.4, minTemp: 24.8, avgHum: 70, events: 2 },
];

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
  generateSensorHistory,
  historyLogs,
  alerts,
  reports,
  auditLog,
};
