import { writeClient, Point } from "../config/influx.js";

export async function sensorHandler(socket, data) {
  const now = Date.now();

  if (!socket.lastEmitTime) socket.lastEmitTime = 0;

  // throttle: allow only every 1 second
  if (now - socket.lastEmitTime < 1000) return;

  socket.lastEmitTime = now;

  // ---- Validation ----
  if (
    !data ||
    typeof data.temperature !== "number" ||
    typeof data.humidity !== "number" ||
    typeof data.mq2_1_ppm !== "number" ||
    typeof data.mq2_2_ppm !== "number" ||
    typeof data.heat_index !== "number" ||
    typeof data.smoke_status !== "string" ||
    typeof data.environment_status !== "string"
  ) {
    console.log("[SENSOR] Invalid payload:", data);
    return;
  }

  const timestamp = new Date();   // precision: ms (matches writeClient config)

  console.log(
    `[SENSOR] Temp: ${data.temperature}°C | Humidity: ${data.humidity}%` +
      ` | MQ2-1: ${data.mq2_1_ppm} ppm | MQ2-2: ${data.mq2_2_ppm} ppm` +
      ` | HI: ${data.heat_index}°C` +
      ` | Smoke: ${data.smoke_status} | Env: ${data.environment_status}`,
  );

  // ---- Write to InfluxDB ----
  const point = new Point("sensor_environment")
    .floatField("temperature", data.temperature)
    .floatField("humidity", data.humidity)
    .floatField("mq2_1_ppm", data.mq2_1_ppm)
    .floatField("mq2_2_ppm", data.mq2_2_ppm)
    .floatField("heat_index", data.heat_index)
    .tag("smoke_status", data.smoke_status)
    .tag("temp_status", data.temp_status)
    .tag("environment_status", data.environment_status)
    .timestamp(timestamp);

  try {
    writeClient.writePoint(point);
    await writeClient.flush();
    console.log("[SENSOR] Saved to InfluxDB");
  } catch (error) {
    console.error("[SENSOR] InfluxDB Error:", error);
  }

  // ---- Broadcast to dashboard ----
  try {
    socket.broadcast.volatile.emit("sensorData", {
      temperature: data.temperature,
      humidity: data.humidity,
      mq2_1_ppm: data.mq2_1_ppm,
      mq2_2_ppm: data.mq2_2_ppm,
      heat_index: data.heat_index,
      smoke_status: data.smoke_status,
      temp_status: data.temp_status,
      environment_status: data.environment_status,
      timestamp: timestamp.toISOString(),
    });
  } catch (error) {
    console.error("[SENSOR] Emit error:", error);
  }
}
