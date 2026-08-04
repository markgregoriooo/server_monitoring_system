import { queryClient, bucket } from "../config/influx.js";
import { resolveRange } from "../services/snmpUtils.js";

// GET /api/ups/:id/history?range=-1h  (JWT, via authMiddleware)
//   ...or an absolute window: ?start=<ISO>&stop=<ISO>  (see snmpUtils.resolveRange)
// Battery/load/voltage history for one UPS from InfluxDB (`ups_metrics`). These are
// all plain gauges, so a windowed mean reads cleanly (unlike the cumulative byte
// counters in network/server history).
//
// Ranges and the custom-window rules come from the SHARED resolver, so this page and
// the network page always offer the same choices — a battery discharge and the
// traffic during the same outage have to be comparable over the same period.
export function upsHistoryHandler(req, res) {
  const deviceId = parseInt(req.params.id, 10);
  if (!Number.isInteger(deviceId)) {
    return res.status(400).json({ error: "Invalid device id." });
  }

  let resolved;
  try {
    resolved = resolveRange(req.query);
  } catch (err) {
    return res.status(err.status ?? 400).json({ error: err.message });
  }
  const { rangeExpr, every } = resolved;

  const flux = `
    from(bucket: "${bucket}")
      |> range(${rangeExpr})
      |> filter(fn: (r) => r._measurement == "ups_metrics")
      |> filter(fn: (r) => r.device_id == "${deviceId}")
      |> filter(fn: (r) =>
          r._field == "battery_charge_pct" or
          r._field == "load_pct" or
          r._field == "runtime_remaining_min" or
          r._field == "input_voltage" or
          r._field == "output_voltage" or
          r._field == "temperature")
      |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)
      |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> sort(columns: ["_time"], desc: false)
  `;

  const history = [];
  queryClient.queryRows(flux, {
    next(row, tableMeta) {
      const d = tableMeta.toObject(row);
      history.push({
        time: d._time,
        batteryChargePct: d.battery_charge_pct ?? null,
        loadPct: d.load_pct ?? null,
        runtimeRemainingMin: d.runtime_remaining_min ?? null,
        inputVoltage: d.input_voltage ?? null,
        outputVoltage: d.output_voltage ?? null,
        temperature: d.temperature ?? null,
      });
    },
    error(error) {
      console.error("[UPS_HISTORY] query error:", error.message);
      if (!res.headersSent) res.status(500).json({ error: "History query failed." });
    },
    complete() {
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
