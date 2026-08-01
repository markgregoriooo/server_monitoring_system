// ── In-memory mock store — ONE mock left ─────────────────────────────────────
// This file used to back several features before they had real stores. All but one
// are now gone:
//
//   servers              → real: MySQL devices + server_specs, InfluxDB server_metrics
//   alerts               → real: MySQL alerts + alert_notifications (services/alertsService)
//   generateSensorHistory→ real: Socket.IO changeRange → querySensorHistoryHandler (Flux)
//   historyLogs          → real: services/environmentService.js (InfluxDB daily summary)
//   auditLog             → never used; system_logs + services/historyService cover it
//
// `reports` is the last one still wired up (routes/reports.js). It is a genuine mock:
// POST /api/reports pushes a row here and reports "Generated" with no file behind it,
// and the array resets on restart. The real implementation — reportService.js +
// reportRenderer.js writing CSV/PDF against the `reports` MySQL table — lives on the
// `reports-page` branch. When that merges, this file's last consumer disappears and
// the whole `data/` folder can be deleted.

// ── REPORTS (mock — see above) ────────────────────────────────────────────────
const reports = [
  { id: 1, title: "Daily Temperature Report", date: "2025-03-12", status: "Generated", type: "Environment" },
  { id: 2, title: "Weekly Server Metrics",    date: "2025-03-10", status: "Generated", type: "Server"      },
  { id: 3, title: "Monthly Uptime Summary",   date: "2025-03-01", status: "Generated", type: "Server"      },
  { id: 4, title: "Alert History Report",     date: "2025-03-12", status: "Pending",   type: "Alerts"      },
];

export { reports };
