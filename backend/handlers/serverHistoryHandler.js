import { queryClient, bucket } from "../config/influx.js";
import { resolveHistoryRequest, historyEnvelope } from "../services/historyRange.js";
import { describeError } from "../utils/httpError.js";

// GET /api/servers/:id/history?range=-1h  (JWT, via authMiddleware)
//   ...or an absolute window: ?start=<ISO>&stop=<ISO>
//
// A server's metric history from InfluxDB (`server_metrics`), aggregated into
// windows. Ranges come from services/historyRange.js, which also keeps user input
// out of the Flux query.
export function serverHistoryHandler(req, res) {
  const parsed = resolveHistoryRequest(req, res, "server");
  if (!parsed) return;
  const { deviceId, resolved } = parsed;
  const { rangeExpr, every } = resolved;

  // CPU/mem/disk % are averaged per window. The network fields are cumulative byte
  // counters, so they use `last`; the frontend diffs consecutive values to get the
  // average throughput.
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
      console.error("[SERVER_HISTORY] query error:", describeError(error));
      if (!res.headersSent) res.status(500).json({ error: "History query failed." });
    },
    complete() {
      // Return the range, span and window actually used, so the client can label the
      // axis (dates for multi-day ranges).
      if (!res.headersSent) {
        res.json(historyEnvelope(resolved, { history }));
      }
    },
  });
}
