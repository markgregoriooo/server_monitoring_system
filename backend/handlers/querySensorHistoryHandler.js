import { queryClient } from "../config/influx.js";

export function sendSensorHistory(socket, range = "-1h") {

  let aggregateWindow = '';

  if (range === "-30m" || range === "-1h") {
    aggregateWindow = '|> aggregateWindow(every: 3m, fn: mean, createEmpty: false)';
  }

  if (range === "-24h") {
    aggregateWindow = '|> aggregateWindow(every: 5m, fn: mean, createEmpty: false)';
  }

  const fluxQuery = `
  from(bucket: "monitoring")
    |> range(start: ${range})
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
        humidity: data.humidity ?? null
      });
    },

    error(error) {
      console.error("Query Error:", error);
    },

    complete() {
      console.log("History sent:", history.length, "records");
      socket.emit("sensorHistory", history);
    }

  });
}