import { queryClient, bucket } from "../config/influx.js";
import { resolveHistoryRequest, historyEnvelope } from "../services/historyRange.js";
import { describeError } from "../utils/httpError.js";

// GET /api/network/:id/history?range=-1h[&interface=ether1]  (JWT, via authMiddleware)
//   ...or an absolute window: ?start=<ISO>&stop=<ISO>  (see historyRange.resolveRange)
//
// One router's history from two measurements:
//   network_traffic  → rxBytesPerSec / txBytesPerSec   (SNMP + MikroTik)
//   router_metrics   → latencyMs / packetLossPct       (ICMP, every router)
//
// A ping-only router writes nothing to network_traffic, so the ICMP half is what
// gives it a chart. The two come back as separate arrays because they do not share
// timestamps. `interface` limits the throughput half to one port; it goes into an
// equality filter as a JSON-escaped string, never as Flux code.
export function networkHistoryHandler(req, res) {
  const parsed = resolveHistoryRequest(req, res);
  if (!parsed) return;
  const { deviceId, resolved } = parsed;
  const { rangeExpr, every } = resolved;

  // JSON.stringify gives a safely quoted+escaped Flux string literal.
  const iface = req.query.interface ? String(req.query.interface).slice(0, 100) : "";
  const ifaceFilter = iface
    ? `|> filter(fn: (r) => r.interface_name == ${JSON.stringify(iface)})`
    : "";

  // network_traffic stores cumulative byte counters per interface: align each
  // interface to the windows (last), take the non-negative derivative (bytes/sec),
  // then sum across interfaces per window.
  const throughputFlux = `
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

  // ICMP values: mean per window. Spikes are what the alert rules catch.
  const icmpFlux = `
    from(bucket: "${bucket}")
      |> range(${rangeExpr})
      |> filter(fn: (r) => r._measurement == "router_metrics")
      |> filter(fn: (r) => r.device_id == "${deviceId}")
      |> filter(fn: (r) => r._field == "latency_ms" or r._field == "packet_loss_pct")
      |> group(columns: ["_field"])
      |> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)
      |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> sort(columns: ["_time"], desc: false)
  `;

  const rows = (flux) =>
    new Promise((resolve, reject) => {
      const out = [];
      queryClient.queryRows(flux, {
        next(row, tableMeta) {
          out.push(tableMeta.toObject(row));
        },
        error: reject,
        complete: () => resolve(out),
      });
    });

  Promise.all([rows(throughputFlux), rows(icmpFlux)])
    .then(([tp, icmp]) => {
      // Two arrays, not one merged series. The measurements land in different windows,
      // so merging them put nulls into both, and the chart drew every null as a gap.
      // The page shows throughput or ICMP, never both on one axis.
      const history = tp.map((d) => ({
        time: d._time,
        rxBytesPerSec: d.rx_bytes ?? null,
        txBytesPerSec: d.tx_bytes ?? null,
      }));
      const icmpHistory = icmp.map((d) => ({
        time: d._time,
        latencyMs: d.latency_ms ?? null,
        packetLossPct: d.packet_loss_pct ?? null,
      }));

      // Echo what was actually served (incl. the resolved custom bounds + the window
      // that was chosen) so the client can label the axis without re-deriving it.
      if (!res.headersSent) {
        // Now carries spanSec too — it always should have. See R-08.
        res.json(historyEnvelope(resolved, { history, icmp: icmpHistory }));
      }
    })
    .catch((error) => {
      console.error("[NETWORK_HISTORY] query error:", describeError(error));
      if (!res.headersSent) res.status(500).json({ error: "History query failed." });
    });
}
