import { queryClient, bucket } from "../config/influx.js";
import { describeError } from "../utils/httpError.js";

const VALID_QUICK_RANGES = new Set([
  "-30m", "-1h", "-3h", "-6h", "-12h", "-24h", "-2d", "-7d", "-30d",
]);

// No window may be SMALLER than the store cadence in services/envPersistPolicy.js
// (ENV_PERSIST_INTERVAL_MS, 30s default). A stable room now yields one point per 30s, so a
// 10s or 20s window would mostly contain nothing, and `createEmpty: false` drops empty
// windows — the chart would come back with two thirds of its points missing. -30m and -1h
// were 10s/20s when every 3s reading was stored; they are now 30s/1m. Raising the store
// interval means raising these to match.
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
  //
  // `group(columns: ["_field"])` is load-bearing and must stay BEFORE aggregateWindow.
  // sensor_environment is written with three TAGS (smoke_status / temp_status /
  // environment_status — see handlers/sensorHandler.js), so they sit in the Flux group key
  // and split the result into one table per status COMBINATION. Two things went wrong:
  //
  //   1. Ordering. `sort()` orders rows within each table, never across them, and
  //      queryRows streams table by table — so the rows arrived Jul→Aug, then Jul→Aug
  //      again for the next combination. On a 30-day range the room crosses status bands
  //      often enough that the x-axis read "Jul, Aug, Jul, Aug, Jul". Short ranges looked
  //      fine only because the statuses rarely change within an hour (one table).
  //   2. Wrong means. `fn: mean` was averaging each status subgroup separately, producing
  //      several partial means at the SAME _time, of which the map below kept whichever
  //      streamed last. The plotted value was the mean of an arbitrary subset of the
  //      window rather than of the window.
  //
  // Grouping by `_field` alone collapses the tags, so each field is one continuous series:
  // one mean per window over all of it, one table out of pivot, and a global sort.
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
     A THIRD query rather than more fields on the first, because these points carry a
     `channel` TAG: pivoting them into the numeric query would either collapse the channels
     together or split every row by channel, and the numeric query's `group(["_field"])` is
     load-bearing for exactly the opposite reason (see the note above it).

     Grouped by channel so each sensor is its own continuous series, and left as a per-row
     `gas` object rather than flattened into gas_1/gas_2/... fields: the number of sensors is
     data now, and a fixed set of field names is the thing this whole change was undoing.

     ⚠️ The legacy mq2_1_ppm/mq2_2_ppm fields STAY in the numeric query. They are the only
     gas history that exists from before the cutover, so dropping them would blank every
     chart older than today. A row carries whichever it has; the client prefers `gas`. */
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
              // Only attach to windows the numeric query already produced. A gas point with
              // no matching environment row would be a row with no temperature, humidity or
              // status — which the chart would draw as a gap in everything else.
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
    // Belt and braces on the Flux `sort` above: this array's order is really the
    // MAP'S INSERTION order, which is whatever order rows streamed in. The chart
    // plots it as given — a category axis, so it draws points in array order and
    // cannot re-sort them — and every consumer reads "latest" as the last element.
    // Sorting here means neither depends on how Flux happens to table the result.
    const history = Array.from(numericMap.values())
      .sort((a, b) => new Date(a.time) - new Date(b.time));
    console.log("[HISTORY] Sent:", history.length, "records");
    socket.emit("sensorHistory", history);
  }
}
