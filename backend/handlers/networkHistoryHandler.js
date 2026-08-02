import { queryClient, bucket } from "../config/influx.js";

// Allowed ranges → aggregate window. Both sides whitelisted (never taken from user
// input verbatim) so there is no Flux-injection surface. Same set as the others.
const RANGE_WINDOW = {
  "-1h": "20s",
  "-6h": "2m",
  "-24h": "10m",
};

// Interface names are user/vendor-supplied, so they can never be interpolated into
// Flux verbatim. RouterOS and IF-MIB names are alphanumerics plus a few separators —
// anything else is rejected rather than escaped.
const SAFE_IFNAME = /^[A-Za-z0-9._\-/ ]{1,50}$/;

// GET /api/network/:id/history?range=-1h[&interface=ether3]  (JWT, via authMiddleware)
// In/out throughput for one router from InfluxDB (`network_traffic`).
// network_traffic stores CUMULATIVE byte counters per interface, so we: align each
// interface to common windows (last), take the non-negative derivative → bytes/sec
// per interface, then sum per window.
//
// Without `interface` the sum spans every port → device totals (the original behaviour).
// With `interface` the filter narrows to that one port, so a single link can be charted
// — the per-port data was always in Influx, there was just no way to ask for it.
export function networkHistoryHandler(req, res) {
  const deviceId = parseInt(req.params.id, 10);
  if (!Number.isInteger(deviceId)) {
    return res.status(400).json({ error: "Invalid device id." });
  }

  let range = String(req.query.range ?? "-1h");
  if (!RANGE_WINDOW[range]) range = "-1h";
  const every = RANGE_WINDOW[range];

  const iface = req.query.interface ? String(req.query.interface) : "";
  if (iface && !SAFE_IFNAME.test(iface)) {
    return res.status(400).json({ error: "Invalid interface name." });
  }
  const ifaceFilter = iface
    ? `|> filter(fn: (r) => r.interface_name == "${iface}")`
    : "";

  const flux = `
    from(bucket: "${bucket}")
      |> range(start: ${range})
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
      if (!res.headersSent) res.json({ range, interface: iface || null, history });
    },
  });
}
