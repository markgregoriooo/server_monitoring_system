import { queryClient, bucket } from "../config/influx.js";
import { describeError } from "../utils/httpError.js";

const VALID_QUICK_RANGES = new Set([
  "-30m", "-1h", "-3h", "-6h", "-12h", "-24h", "-2d", "-7d", "-30d",
]);

// No window may be smaller than the store interval in services/envPersistPolicy.js
// (ENV_PERSIST_INTERVAL_MS, 30s). A stable room stores one point per 30s, and empty
// windows are dropped, so a smaller window would leave most points missing. Raise
// these if the store interval is raised.
const WINDOW_MAP = {
  "-30m": "30s", "-1h": "1m",  "-3h":  "1m",  "-6h": "2m",
  "-12h": "5m",  "-24h": "10m", "-2d": "20m", "-7d": "1h", "-30d": "3h",
};

// Strict ISO 8601 UTC — no extra characters allowed, prevents Flux injection
const ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function sendSensorHistory(socket, range = "-1h") {
  let safeRangeClause;
  let aggregateWindow;

  if (typeof range === "object" && range !== null) {
    if (!ISO_REGEX.test(range.start) || !ISO_REGEX.test(range.stop)) {
      console.warn("[HISTORY] Invalid custom range rejected:", range);
      return;
    }
    safeRangeClause = `start: ${range.start}, stop: ${range.stop}`;
    aggregateWindow = '|> aggregateWindow(every: 1m, fn: mean, createEmpty: false)';
  } else if (VALID_QUICK_RANGES.has(range)) {
    safeRangeClause = `start: ${range}`;
    aggregateWindow = `|> aggregateWindow(every: ${WINDOW_MAP[range]}, fn: mean, createEmpty: false)`;
  } else {
    console.warn("[HISTORY] Unknown range rejected:", range);
    return;
  }

  // ── Numeric fields query (aggregated) ─────────────────────────────
  // Keep `group(columns: ["_field"])` before aggregateWindow. The three status tags
  // split the result into one table per status combination, which broke the time
  // order on long ranges and averaged each subgroup separately. Grouping by field
  // gives one continuous series per field.
  const numericQuery = `
    from(bucket: "${bucket}")
      |> range(${safeRangeClause})
      |> filter(fn: (r) => r._measurement == "sensor_environment")
      |> filter(fn: (r) =>
          r._field == "temperature" or
          r._field == "humidity"    or
          r._field == "mq2_1_ppm"  or
          r._field == "mq2_2_ppm"  or
          r._field == "heat_index"
        )
      |> group(columns: ["_field"])
      ${aggregateWindow}
      |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> sort(columns: ["_time"], desc: false)
  `;

  /* ── Per-sensor gas (`sensor_gas`, one series per channel) ──────────────────────────
     A separate query because these points carry a `channel` tag. Grouped by channel,
     and returned as a per-row `gas` object since the number of sensors can change.
     The legacy mq2_1_ppm/mq2_2_ppm fields stay in the numeric query because older
     history only has those. The client prefers `gas`. */
  const gasQuery = `
    from(bucket: "${bucket}")
      |> range(${safeRangeClause})
      |> filter(fn: (r) => r._measurement == "sensor_gas" and r._field == "ppm")
      |> group(columns: ["channel"])
      ${aggregateWindow}
      |> sort(columns: ["_time"], desc: false)
  `;

  // ── Tag fields query (last value per window — tags can't be aggregated) ──
  const tagQuery = `
    from(bucket: "${bucket}")
      |> range(${safeRangeClause})
      |> filter(fn: (r) => r._measurement == "sensor_environment")
      |> filter(fn: (r) => r._field == "temperature")
      ${aggregateWindow.replace("fn: mean", "fn: last")}
      |> keep(columns: ["_time", "smoke_status", "temp_status", "environment_status"])
      |> sort(columns: ["_time"], desc: false)
  `;

  const numericMap = new Map();

  queryClient.queryRows(numericQuery, {
    next(row, tableMeta) {
      const d = tableMeta.toObject(row);
      numericMap.set(d._time, {
        time:        d._time,
        temperature: d.temperature ?? null,
        humidity:    d.humidity    ?? null,
        mq2_1_ppm:  d.mq2_1_ppm  ?? null,
        mq2_2_ppm:  d.mq2_2_ppm  ?? null,
        // Filled by gasQuery below: { "1": 38.2, "3": 41.0 }. Absent for windows older than
        // the multi-sensor cutover, where the legacy pair above is all there is.
        gas:         null,
        heat_index:  d.heat_index  ?? null,
        smoke_status:       null,
        temp_status:        null,
        environment_status: null,
      });
    },
    error(error) {
      console.error("[HISTORY] Numeric query error:", describeError(error));
    },
    complete() {
      queryClient.queryRows(tagQuery, {
        next(row, tableMeta) {
          const d = tableMeta.toObject(row);
          if (numericMap.has(d._time)) {
            const entry = numericMap.get(d._time);
            entry.smoke_status       = d.smoke_status       ?? null;
            entry.temp_status        = d.temp_status        ?? null;
            entry.environment_status = d.environment_status ?? null;
          }
        },
        error(error) {
          console.error("[HISTORY] Tag query error:", describeError(error));
        },
        complete() {
          queryClient.queryRows(gasQuery, {
            next(row, tableMeta) {
              const d = tableMeta.toObject(row);
              const entry = numericMap.get(d._time);
              // Only attach gas to windows the numeric query returned; otherwise the row would
              // have no temperature or humidity and show as a gap.
              if (!entry || d._value == null) return;
              (entry.gas ??= {})[String(d.channel)] = d._value;
            },
            error(error) {
              console.error("[HISTORY] Gas query error:", describeError(error));
            },
            complete() {
              emitHistory();
            },
          });
        },
      });
    },
  });

  function emitHistory() {
    // Sort by time here as well: the array order is the map's insertion order, and the
    // chart plots points in array order.
    const history = Array.from(numericMap.values())
      .sort((a, b) => new Date(a.time) - new Date(b.time));
    console.log("[HISTORY] Sent:", history.length, "records");
    socket.emit("sensorHistory", history);
  }
}
