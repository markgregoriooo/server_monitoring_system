import { writeClient, Point } from "../config/influx.js";
import notificationService from "../services/notificationService.js";

// ESP32 status strings (env_monitor_v2.ino) → notification severity.
const ENV_SEVERITY = { WARNING: "warning", DANGER: "critical", CRITICAL: "critical" };
const ENV_RANK = { NORMAL: 0, TOO_COLD: 0, WARNING: 1, DANGER: 2, CRITICAL: 3 };

// Raise an environment alert only when the room's status ESCALATES into a worse
// band — not on every 1s reading, and not on recovery. The DB cooldown in
// notificationService then suppresses repeats while it sits in that band.
let lastEnvStatus = "NORMAL";
function maybeRaiseEnvAlert(data) {
  const status = data.environment_status;
  const rank = ENV_RANK[status] ?? 0;
  const worsened = rank > (ENV_RANK[lastEnvStatus] ?? 0);
  lastEnvStatus = status;
  if (!worsened || !ENV_SEVERITY[status]) return;

  const smoke = data.smoke_status === "DANGER";
  const gas = Math.max(data.mq2_1_ppm, data.mq2_2_ppm);
  notificationService.raiseAlert({
    deviceId: null, // the ESP32 isn't a devices row — this is a room-level (system) alert
    type: "environment",
    severity: ENV_SEVERITY[status],
    title: smoke ? "Smoke detected — server room" : `Server room ${status.toLowerCase()}`,
    message: `Temp ${data.temperature}°C · humidity ${data.humidity}% · gas ${gas}ppm (${status})`,
  });
}

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

  // ---- Environment alert (temp / humidity / gas / smoke escalation) ----
  maybeRaiseEnvAlert(data);
}
