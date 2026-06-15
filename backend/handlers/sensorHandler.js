import { writeClient, Point } from "../config/influx.js";
import notificationService from "../services/notificationService.js";
import alertRulesService from "../services/alertRulesService.js";
import alertsService from "../services/alertsService.js";
import alertBandState from "../services/alertBandState.js";

const SEV_RANK = alertRulesService.SEV_RANK;

// Environment alerting is now rule-driven (alert_rules, device_id NULL = room-level),
// replacing the firmware's fixed status bands. Each reported metric is evaluated
// against its configurable thresholds and raises a PER-METRIC alert on the onset of a
// worse band — nextBand applies hysteresis and the DB cooldown suppresses repeats. The
// ESP32 isn't a `devices` row, so these stay system alerts (deviceId null) with no
// device_logs. The firmware's environment_status is still used for the dashboard +
// InfluxDB tags; it just no longer drives notifications. The per-metric "current band"
// lives in the shared alertBandState (deviceId null = room-level) so the alert lifecycle
// can re-arm it: after a resolve, a still-breaching metric re-alerts on the next reading.

// metric_name (must match the seeded rules) → how to read it + phrase the alert.
const ENV_METRICS = {
  temperature: { value: (d) => d.temperature, unit: "°C", label: "Server room temperature" },
  gas: { value: (d) => Math.max(d.mq2_1_ppm, d.mq2_2_ppm), unit: "ppm", label: "Server room gas" },
  humidity: { value: (d) => d.humidity, unit: "%", label: "Server room humidity" },
};

async function maybeRaiseEnvAlert(data) {
  try {
    for (const [key, meta] of Object.entries(ENV_METRICS)) {
      const v = meta.value(data);
      if (typeof v !== "number" || Number.isNaN(v)) continue;

      const rules = await alertRulesService.getEffectiveRules(null, key);
      const prev = alertBandState.getBand(null, key);
      const { band, rule } = alertRulesService.nextBand(rules, v, prev);
      alertBandState.setBand(null, key, band);

      // Recovery: metric back to normal → auto-resolve its open room-level alerts.
      if (band === "normal" && prev !== "normal") {
        await alertsService.autoResolveMetric(null, key);
      }
      if (SEV_RANK[band] <= SEV_RANK[prev]) continue; // only act on escalation

      // Smoke = a gas reading the firmware flags DANGER — give it a clearer title.
      const smoke = key === "gas" && data.smoke_status === "DANGER";
      const word = band === "critical" ? "critical" : band === "warning" ? "high" : band;
      await notificationService.raiseAlert({
        deviceId: null, // ESP32 isn't a devices row — this is a room-level (system) alert
        type: key,
        severity: band,
        title: smoke ? "Smoke detected — server room" : `${meta.label} ${word}`,
        message: `${meta.label} ${word}: ${Math.round(v * 10) / 10}${meta.unit}`,
        metricValue: v,
        alertRuleId: rule?.alert_rule_id ?? null,
      });
    }
  } catch (err) {
    console.error("[SENSOR] env alert error:", err.message);
  }
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
  await maybeRaiseEnvAlert(data);
}
