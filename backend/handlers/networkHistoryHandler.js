import { queryClient, bucket } from "../config/influx.js";
import { resolveRange } from "../services/historyRange.js";

// GET /api/network/:id/history?range=-1h[&interface=ether1]  (JWT, via authMiddleware)
//   ...or an absolute window: ?start=<ISO>&stop=<ISO>  (see historyRange.resolveRange)
// In/out throughput for one router from InfluxDB (`network_traffic`).
// network_traffic stores CUMULATIVE byte counters per interface, so we: align each
// interface to common windows (last), take the non-negative derivative → bytes/sec
// per interface, then group across interfaces and sum per window → device totals.
//
// `interface` narrows to a single port. The data was always tagged by
// interface_name; there was simply no way to ask for one port, so a busy uplink was
// only ever visible summed together with every idle port. The value is passed
// through an EQUALITY filter built from a JSON-escaped string, never interpolated as
// Flux code, so it can't break out of the literal (the range/window pair stays
// whitelisted above for the same reason).
export function networkHistoryHandler(req, res) {
  const deviceId = parseInt(req.params.id, 10);
  if (!Number.isInteger(deviceId)) {
    return res.status(400).json({ error: "Invalid device id." });
  }

  // Preset (-1h … -30d) or an absolute start/stop window; throws a 400 on a
  // malformed custom window rather than silently charting the wrong period.
  let resolved;
  try {
    resolved = resolveRange(req.query);
  } catch (err) {
    return res.status(err.status ?? 400).json({ error: err.message });
  }
  const { rangeExpr, every } = resolved;

  // JSON.stringify gives a safely quoted+escaped Flux string literal.
  const iface = req.query.interface ? String(req.query.interface).slice(0, 100) : "";
  const ifaceFilter = iface
    ? `|> filter(fn: (r) => r.interface_name == ${JSON.stringify(iface)})`
    : "";

  const flux = `
    from(bucket: "${bucket}")
      |> range(${rangeExpr})
      |> filter(fn: (r) => r._measurement == "network_traffic")
      |> filter(fn: (r) => r.device_id == "${deviceId}")
      ${ifaceFilter}
      |> filter(fn: (r) => r._field == "rx_bytes" or r._field == "tx_bytes")
      |> aggregateWindow(every: ${every}, fn: last, createEmpty: false)
      |> derivative(unit: 1s, nonNegative: true)
      |> group(columns: ["_field"])
      |> aggregateWindow(every: ${every}, fn: sum, createEmpty: false)
      |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> sort(columns: ["_time"], desc: false)
  `;

  const history = [];
  queryClient.queryRows(flux, {
    next(row, tableMeta) {
      const d = tableMeta.toObject(row);
      history.push({
        time: d._time,
        rxBytesPerSec: d.rx_bytes ?? null,
        txBytesPerSec: d.tx_bytes ?? null,
      });
    },
    error(error) {
      console.error("[NETWORK_HISTORY] query error:", error.message);
      if (!res.headersSent) res.status(500).json({ error: "History query failed." });
    },
    complete() {
      // Echo what was actually served (incl. the resolved custom bounds + the window
      // that was chosen) so the client can label the axis without re-deriving it.
      if (!res.headersSent) {
        res.json({
          range: resolved.custom ? "custom" : resolved.preset,
          start: resolved.startISO ?? null,
          stop: resolved.stopISO ?? null,
          every,
          history,
        });
      }
    },
  });
}
