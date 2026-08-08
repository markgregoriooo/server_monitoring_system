import { queryClient, bucket } from "../config/influx.js";
import { resolveRange } from "../services/historyRange.js";

// GET /api/servers/:id/history?range=-1h  (JWT, via authMiddleware)
//   ...or an absolute window: ?start=<ISO>&stop=<ISO>
//
// Returns the server's real metric history from InfluxDB (measurement
// `server_metrics`) for the chosen range, aggregated into time windows.
//
// Range presets (-1h … -30d) and the custom-window rules live in
// services/historyRange.js, shared so every history endpoint offers the same
// choices. That module also owns the Flux-injection guarantee: presets are a fixed
// whitelist and custom bounds are re-serialised from Date, so no user text ever
// reaches the query string built below.
export function serverHistoryHandler(req, res) {
  const deviceId = parseInt(req.params.id, 10);
  if (!Number.isInteger(deviceId)) {
    return res.status(400).json({ error: "Invalid server id." });
  }

  // A malformed CUSTOM window is a 400 — silently charting the wrong period is
  // worse than saying the input was rejected. An unknown PRESET still falls back
  // to -1h, as it always has.
  let resolved;
  try {
    resolved = resolveRange(req.query);
  } catch (err) {
    return res.status(err.status ?? 400).json({ error: err.message });
  }
  const { rangeExpr, every } = resolved;

  // Gauges (cpu/mem/disk %) average cleanly over a window. The network fields are
  // cumulative byte counters, so averaging them smears the value — aggregate those
  // with `last` instead, giving the exact counter at each window edge so the
  // frontend's consecutive-diff yields the true average throughput for the window.
  const flux = `
    base = from(bucket: "${bucket}")
      |> range(${rangeExpr})
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
      // Echo what was actually served — including the resolved custom bounds, the
      // span, and the window that was chosen — so the client can label the axis
      // (a multi-day window needs DATES on it) without re-deriving any of it.
      if (!res.headersSent) {
        res.json({
          range: resolved.custom ? "custom" : resolved.preset,
          start: resolved.startISO ?? null,
          stop: resolved.stopISO ?? null,
          spanSec: resolved.spanSec ?? null,
          every,
          history,
        });
      }
    },
  });
}
