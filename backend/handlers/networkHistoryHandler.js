import { queryClient, bucket } from "../config/influx.js";
import { resolveHistoryRequest, historyEnvelope } from "../services/historyRange.js";
import { describeError } from "../utils/httpError.js";

// GET /api/network/:id/history?range=-1h[&interface=ether1]  (JWT, via authMiddleware)
//   ...or an absolute window: ?start=<ISO>&stop=<ISO>  (see historyRange.resolveRange)
//
// One router's history, from TWO measurements merged on the time axis:
//
//   network_traffic  → rxBytesPerSec / txBytesPerSec   (SNMP + MikroTik)
//   router_metrics   → latencyMs / packetLossPct       (ICMP, every router)
//
// The ICMP half is why this is two queries rather than one. A PING-ONLY router — one
// registered with no SNMP community, i.e. ISP-owned CPE — writes nothing at all to
// network_traffic, so this endpoint returned an empty array for it and every chart
// drawn from it said "no data" forever. Latency and packet loss were being collected
// and stored the whole time; nothing ever asked for them.
//
// Both come back from ONE request (one range, one window) but as TWO arrays, because
// they do not share timestamps: a 60s poll against the -1h preset's 20s window leaves
// most windows empty, and `createEmpty: false` keeps a different subset for each
// measurement. Merging them per-timestamp injected nulls into whichever series was
// absent, and the client draws a null as a GAP — so throughput lines came out shattered
// on devices that had no downtime at all. Nothing needs them interleaved: a chart shows
// throughput or ICMP, never both on one axis.
//
// `interface` narrows the THROUGHPUT half to a single port. The data was always tagged
// by interface_name; there was simply no way to ask for one port, so a busy uplink was
// only ever visible summed together with every idle port. It does not touch the ICMP
// half, which is per-device and has no interface to narrow to. The value is passed
// through an EQUALITY filter built from a JSON-escaped string, never interpolated as
// Flux code, so it can't break out of the literal (the range/window pair stays
// whitelisted in resolveRange for the same reason).
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

  // network_traffic stores CUMULATIVE byte counters per interface, so: align each
  // interface to common windows (last), take the non-negative derivative → bytes/sec
  // per interface, then group across interfaces and sum per window → device totals.
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

  // ICMP gauges — plain means over the same windows. `mean`, not `max`: a chart of the
  // typical figure is what shows a link degrading, and the worst-case spike is already
  // what the alert rules watch for.
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
      // TWO ARRAYS, NOT ONE MERGED SERIES.
      //
      // These were merged into one row per timestamp, as a union. That was wrong, and
      // visibly so: the two measurements do not land in the same windows. A 60s poll
      // against a 20s window (the -1h preset) leaves two thirds of the windows empty,
      // and `createEmpty: false` means each query keeps a DIFFERENT subset of them. The
      // union therefore produced rows carrying latency but no throughput, and the
      // client — which inserts a gap wherever a value is null, so a real outage reads as
      // a hole rather than a straight line across it — shattered every throughput line
      // into fragments. On a MikroTik with no downtime at all the chart looked chopped
      // up; at -1h there was often no continuous line left to draw.
      //
      // Nothing needs them interleaved. The page draws throughput OR ICMP, never both on
      // one axis (an SNMP router charts bytes/sec, a ping-only router charts ms and %),
      // so each series keeps its own timestamps and its own gaps mean what they say.
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
