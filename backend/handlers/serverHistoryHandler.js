import { queryClient, bucket } from "../config/influx.js";

// Allowed ranges → aggregate window. Both sides are whitelisted (never taken
// from user input verbatim) so there is no Flux injection surface here.
//
// Windows are chosen to keep every range at roughly 150–200 points: enough shape
// to read, few enough that a 30d query doesn't ship megabytes to the browser or
// make Influx scan-and-return millions of raw points.
const RANGE_WINDOW = {
  "-1h": "20s",
  "-6h": "2m",
  "-24h": "10m",
  "-7d": "1h",
  "-30d": "4h",
};

// GET /api/servers/:id/history?range=-1h  (JWT, via authMiddleware)
// Returns the server's real metric history from InfluxDB (measurement
// `server_metrics`) for the chosen range, aggregated into time windows.
export function serverHistoryHandler(req, res) {
  const deviceId = parseInt(req.params.id, 10);
  if (!Number.isInteger(deviceId)) {
    return res.status(400).json({ error: "Invalid server id." });
  }

  let range = String(req.query.range ?? "-1h");
  if (!RANGE_WINDOW[range]) range = "-1h";
  const every = RANGE_WINDOW[range];

  // Gauges (cpu/mem/disk %) average cleanly over a window. The network fields are
  // cumulative byte counters, so averaging them smears the value — aggregate those
  // with `last` instead, giving the exact counter at each window edge so the
  // frontend's consecutive-diff yields the true average throughput for the window.
  const flux = `
    base = from(bucket: "${bucket}")
      |> range(start: ${range})
      |> filter(fn: (r) => r._measurement == "server_metrics")
      |> filter(fn: (r) => r.device_id == "${deviceId}")

    gauges = base
      |> filter(fn: (r) =>
          r._field == "cpu_percent" or
          r._field == "mem_percent" or
          r._field == "disk_percent")
      |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)

    counters = base
      |> filter(fn: (r) =>
          r._field == "net_bytes_sent" or
          r._field == "net_bytes_recv")
      |> aggregateWindow(every: ${every}, fn: last, createEmpty: false)

    union(tables: [gauges, counters])
      |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> sort(columns: ["_time"], desc: false)
  `;

  const history = [];
  queryClient.queryRows(flux, {
    next(row, tableMeta) {
      const d = tableMeta.toObject(row);
      history.push({
        time: d._time,
        cpu_percent: d.cpu_percent ?? null,
        mem_percent: d.mem_percent ?? null,
        disk_percent: d.disk_percent ?? null,
        net_bytes_sent: d.net_bytes_sent ?? null,
        net_bytes_recv: d.net_bytes_recv ?? null,
      });
    },
    error(error) {
      console.error("[SERVER_HISTORY] query error:", error.message);
      if (!res.headersSent) res.status(500).json({ error: "History query failed." });
    },
    complete() {
      if (!res.headersSent) res.json({ range, history });
    },
  });
}
