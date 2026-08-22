import { queryClient, bucket } from "../config/influx.js";
import { resolveRange } from "../services/historyRange.js";

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
// They are merged into one row per timestamp rather than served from a second endpoint
// so a caller gets one request, one range, one set of labels — and the Dashboard can
// switch which series it draws by mode without re-fetching.
//
// `interface` narrows the THROUGHPUT half to a single port. The data was always tagged
// by interface_name; there was simply no way to ask for one port, so a busy uplink was
// only ever visible summed together with every idle port. It does not touch the ICMP
// half, which is per-device and has no interface to narrow to. The value is passed
// through an EQUALITY filter built from a JSON-escaped string, never interpolated as
// Flux code, so it can't break out of the literal (the range/window pair stays
// whitelisted in resolveRange for the same reason).
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
      // Merge on the timestamp. Both queries used the same range and the same `every`,
      // so their windows line up — but a router can legitimately appear in one and not
      // the other (a ping device has no traffic; a router polled before the ICMP fields
      // existed has no latency), so the merge is a union, not a join. Missing values
      // stay null and the client draws a gap rather than a zero.
      const byTime = new Map();
      const at = (t) => {
        if (!byTime.has(t)) {
          byTime.set(t, {
            time: t,
            rxBytesPerSec: null,
            txBytesPerSec: null,
            latencyMs: null,
            packetLossPct: null,
          });
        }
        return byTime.get(t);
      };
      for (const d of tp) {
        const p = at(d._time);
        p.rxBytesPerSec = d.rx_bytes ?? null;
        p.txBytesPerSec = d.tx_bytes ?? null;
      }
      for (const d of icmp) {
        const p = at(d._time);
        p.latencyMs = d.latency_ms ?? null;
        p.packetLossPct = d.packet_loss_pct ?? null;
      }
      // Sorted in JS: the array's order is really the Map's insertion order, which is
      // whichever query happened to reach a given timestamp first. Same reasoning as
      // querySensorHistoryHandler's final sort.
      const history = [...byTime.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

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
    })
    .catch((error) => {
      console.error("[NETWORK_HISTORY] query error:", error.message);
      if (!res.headersSent) res.status(500).json({ error: "History query failed." });
    });
}
