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
  // counters: per window, the bytes the raw samples added ÷ the seconds they cover
  // (time-weighted, on their real timestamps) — returned as bytes/sec.
  // ⚠️ Not `last` per window and a diff in the browser, which is what this used to do:
  // that divides one sample interval's bytes by the WINDOW spacing, so an agent whose
  // interval does not divide the window swung the chart up and down, and the join
  // between history (window time) and the first live point (sample time) spiked.
  // Same fix as networkHistoryHandler.
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
      // Same group key as \`rates\` below, so the pivot merges both into ONE row per time.
      |> keep(columns: ["_time", "_field", "_value"])
      |> group(columns: ["_field"])

    rates = base
      |> filter(fn: (r) =>
          r._field == "net_bytes_sent" or
          r._field == "net_bytes_recv")
      |> elapsed(unit: 1s)
      |> difference(nonNegative: true)
      |> filter(fn: (r) => exists r._value and r.elapsed > 0)
      |> window(every: ${every})
      |> reduce(
          fn: (r, accumulator) => ({
            bytes: accumulator.bytes + float(v: r._value),
            secs: accumulator.secs + float(v: r.elapsed),
          }),
          identity: { bytes: 0.0, secs: 0.0 },
        )
      |> map(fn: (r) => ({ _time: r._stop, _field: r._field, _value: r.bytes / r.secs }))
      |> group(columns: ["_field"])

    union(tables: [gauges, rates])
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
        // bytes/sec (see the query): the derivative keeps the field names.
        net_sent_bps: d.net_bytes_sent ?? null,
        net_recv_bps: d.net_bytes_recv ?? null,
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
