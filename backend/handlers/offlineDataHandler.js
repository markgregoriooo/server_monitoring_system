import { writeClient, Point } from "../config/influx.js";

// Handles SD card buffer rows flushed by ESP32 after WiFi restore.
// Same fields as sensorHandler but:
//   - uses ESP32 RTC timestamp (historical, not now)
//   - no broadcast to dashboard (it's historical data, not live)
//   - no throttle (flush as fast as possible)

export async function offlineDataHandler(socket, data) {
  if (
    !data ||
    typeof data.temperature        !== "number" ||
    typeof data.humidity           !== "number" ||
    typeof data.mq2_1_ppm         !== "number" ||
    typeof data.mq2_2_ppm         !== "number" ||
    typeof data.heat_index         !== "number" ||
    typeof data.smoke_status       !== "string" ||
    typeof data.temp_status        !== "string" ||
    typeof data.environment_status !== "string" ||
    typeof data.timestamp          !== "string"
  ) {
    console.log("[OFFLINE] Invalid payload:", data);
    return;
  }

  // Use the RTC timestamp from ESP32 — this is historical data
  const timestamp = new Date(data.timestamp);
  if (isNaN(timestamp.getTime())) {
    console.log("[OFFLINE] Bad timestamp:", data.timestamp);
    return;
  }

  console.log(`[OFFLINE] Writing historical row: ${data.timestamp}`);

  const point = new Point("sensor_environment")
    .floatField("temperature",  data.temperature)
    .floatField("humidity",     data.humidity)
    .floatField("mq2_1_ppm",   data.mq2_1_ppm)
    .floatField("mq2_2_ppm",   data.mq2_2_ppm)
    .floatField("heat_index",   data.heat_index)
    .tag("smoke_status",        data.smoke_status)
    .tag("temp_status",         data.temp_status)
    .tag("environment_status",  data.environment_status)
    .timestamp(timestamp);   // ← historical RTC time, not server time

  try {
    writeClient.writePoint(point);
    await writeClient.flush();
    console.log("[OFFLINE] Row saved to InfluxDB:", data.timestamp);
  } catch (error) {
    console.error("[OFFLINE] InfluxDB Error:", error);
  }
}