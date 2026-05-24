import { queryClient } from "../config/influx.js";

// In your sendSensorHistory function, update the aggregateWindow logic:
export function sendSensorHistory(socket, range = "-1h") {

  let aggregateWindow = '';

  if (range === "-30m") {
    aggregateWindow = '|> aggregateWindow(every: 1m, fn: mean, createEmpty: false)';
  } else if (range === "-1h" || range === "-3h") {
    aggregateWindow = '|> aggregateWindow(every: 3m, fn: mean, createEmpty: false)';
  } else if (range === "-6h" || range === "-12h") {
    aggregateWindow = '|> aggregateWindow(every: 10m, fn: mean, createEmpty: false)';
  } else if (range === "-24h") {
    aggregateWindow = '|> aggregateWindow(every: 15m, fn: mean, createEmpty: false)';
  } else if (range === "-2d") {
    aggregateWindow = '|> aggregateWindow(every: 30m, fn: mean, createEmpty: false)';
  } else if (range === "-7d") {
    aggregateWindow = '|> aggregateWindow(every: 2h, fn: mean, createEmpty: false)';
  } else if (range === "-30d") {
    aggregateWindow = '|> aggregateWindow(every: 6h, fn: mean, createEmpty: false)';
  }

  // For custom range, range will be an object { start, stop }
  const isCustom = typeof range === "object" && range.start && range.stop;
  const rangeClause = isCustom
    ? `start: ${range.start}, stop: ${range.stop}`
    : `start: ${range}`;

  const fluxQuery = `
  from(bucket: "monitoring")
    |> range(${rangeClause})
    |> filter(fn: (r) => r._measurement == "sensor_readings")
    |> filter(fn: (r) => r._field == "temperature" or r._field == "humidity")
    ${aggregateWindow}
    |> pivot(rowKey:["_time"], columnKey:["_field"], valueColumn:"_value")
    |> sort(columns: ["_time"], desc: false)
  `;

  const history = [];
  queryClient.queryRows(fluxQuery, {
    next(row, tableMeta) {
      const data = tableMeta.toObject(row);
      history.push({
        time: data._time,
        temperature: data.temperature ?? null,
        humidity: data.humidity ?? null,
      });
    },
    error(error) { console.error("Query Error:", error); },
    complete() {
      console.log("History sent:", history.length, "records");
      socket.emit("sensorHistory", history);
    },
  });
}