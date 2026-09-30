import { writeClient, Point } from "../config/influx.js";
import notificationService from "../services/notificationService.js";
import alertRulesService from "../services/alertRulesService.js";
import alertsService from "../services/alertsService.js";
import alertBandState from "../services/alertBandState.js";
import esp32Monitor from "../services/esp32Monitor.js";
import backupService from "../services/backupService.js";
import envPersistPolicy from "../services/envPersistPolicy.js";
import gasSensorService from "../services/gasSensorService.js";
import { normalizeGas, worstGas, legacyFields } from "../services/gasReadings.js";
import { describeError } from "../utils/httpError.js";

const SEV_RANK = alertRulesService.SEV_RANK;

// How often a reading is stored (see services/envPersistPolicy.js). Validation, the
// heartbeat, the live broadcast and alerts still run on every 3s reading.
const PERSIST_OPTS = envPersistPolicy.resolveOptions(process.env);

// Last stored reading. Module-level, not per socket, because the ESP32 gets a new
// socket on every reconnect.
let lastPersisted = null;

// Environment alerts come from alert_rules (device_id NULL = room-level). Each
// metric raises its own alert when it moves into a worse band; nextBand handles
// hysteresis and the DB cooldown stops repeats. The ESP32 has no devices row, so
// these are system alerts (deviceId null). The current band is kept in the shared
// alertBandState so a still-breaching metric alerts again after a resolve.

// metric_name (must match the seeded rules) → how to read it and word the alert.
// `d.__gas` is the normalised per-channel array, set once per reading.
const ENV_METRICS = {
  temperature: { value: (d) => d.temperature, unit: "°C", label: "Server room temperature" },
  // Max across the wired sensors (gasReadings.worstGas). Null when no channel
  // reported, so the metric is skipped instead of reading 0 ppm.
  gas: { value: (d) => worstGas(d.__gas ?? [])?.ppm ?? null, unit: "ppm", label: "Server room gas" },
  humidity: { value: (d) => d.humidity, unit: "%", label: "Server room humidity" },
};

/**
 * Band to act on for one room metric, with recovery confirmation.
 *
 * Going back down needs several normal readings in a row; this matters for the
 * noisy MQ-2. Going up is still immediate. Split out of maybeRaiseEnvAlert so it
 * can be tested on its own. See audits/code-complexity-report-2026-08-25.md (C-06).
 */
async function settleBand(key, value) {
  const rules = await alertRulesService.getEffectiveRules(null, key);
  const prev = alertBandState.getBand(null, key);
  const { band, rule } = alertRulesService.nextBand(rules, value, prev);

  // A confirmed drop closes what it has made untrue — gas falling from critical to
  // warning closes the CRITICAL alert. See alertsService.settleBand.
  const { effective, downgraded } = await alertsService.settleBand(null, key, prev, band);
  return { band, effective, prev, rule, downgraded };
}

async function maybeRaiseEnvAlert(data) {
  try {
    for (const [key, meta] of Object.entries(ENV_METRICS)) {
      const v = meta.value(data);
      if (typeof v !== "number" || Number.isNaN(v)) continue;

      const { band, effective: effectiveBand, prev, rule, downgraded } = await settleBand(key, v);

      // Only act on escalation — or on a confirmed drop into a band with no open alert.
      if (!downgraded && SEV_RANK[effectiveBand] <= SEV_RANK[prev]) continue;

      // A critical gas reading gets the "Smoke detected" title. "DANGER" is what firmware
      // before 2026-08-15 called that band; drop it once every ESP32 is reflashed.
      const smoke =
        key === "gas" &&
        (data.smoke_status === "CRITICAL" || data.smoke_status === "DANGER");
      const word = band === "critical" ? "critical" : band === "warning" ? "high" : band;

      // Name the sensor with the worst reading, so the alert says where in the room it is.
      const at =
        key === "gas"
          ? (() => {
              const w = worstGas(data.__gas ?? []);
              return w ? ` at ${gasSensorService.labelFor(w.channel)}` : "";
            })()
          : "";
      await notificationService.raiseAlert({
        deviceId: null, // ESP32 isn't a devices row — this is a room-level (system) alert
        type: key,
        severity: band,
        title: smoke ? `Smoke detected — server room${at}` : `${meta.label} ${word}`,
        message: `${meta.label} ${word}: ${Math.round(v * 10) / 10}${meta.unit}${at}`,
        metricValue: v,
        alertRuleId: rule?.alert_rule_id ?? null,
      });
    }
  } catch (err) {
    console.error("[SENSOR] env alert error:", describeError(err));
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
    // Gas is not required: it comes as gas_ppm[] (new firmware) or mq2_1/mq2_2 (old),
    // and the number of channels depends on the wiring. normalizeGas handles both.
    typeof data.heat_index !== "number" ||
    typeof data.smoke_status !== "string" ||
    typeof data.environment_status !== "string"
  ) {
    console.log("[SENSOR] Invalid payload:", data);
    return;
  }

  // A valid reading is the ESP32's heartbeat — this is what keeps the sensor "online"
  // and auto-resolves an open offline alert the instant it comes back.
  esp32Monitor.markSeen();

  // Work out the per-channel gas once and attach it to the payload, so the rules, the
  // InfluxDB write, the backup and the broadcast all use the same numbers. Channels
  // not marked as wired are dropped (a floating ADC pin reads noise).
  data.__gas = normalizeGas(data, gasSensorService.enabledChannels());
  const legacy = legacyFields(data.__gas);   // mq2_1_ppm / mq2_2_ppm, for everything written
                                             // against the two-sensor shape
  const worst = worstGas(data.__gas);

  const timestamp = new Date();   // precision: ms (matches writeClient config)

  // ---- Store, or not ----
  // Most 3s readings are the same as the last one. Store on a 30s heartbeat, plus
  // right away when gas rises, a status changes or temperature/humidity really moves.
  // See services/envPersistPolicy.js. Channels 3+ are included through gas_ppm so a
  // rise on any sensor is stored immediately.
  const sample = {
    at: now,
    temperature: data.temperature,
    humidity: data.humidity,
    mq2_1_ppm: legacy.mq2_1_ppm ?? null,
    mq2_2_ppm: legacy.mq2_2_ppm ?? null,
    gas_ppm: worst?.ppm ?? null,
    heat_index: data.heat_index,
    smoke_status: data.smoke_status,
    temp_status: data.temp_status,
    environment_status: data.environment_status,
  };
  const { persist, reason } = envPersistPolicy.shouldPersist(sample, lastPersisted, PERSIST_OPTS);

  if (persist) {
    lastPersisted = sample;

    console.log(
      `[SENSOR] Temp: ${data.temperature}°C | Humidity: ${data.humidity}%` +
        ` | ${data.__gas.map((g) => `${gasSensorService.labelFor(g.channel)}: ${g.ppm} ppm`).join(" | ") || "no gas sensor"}` +
        ` | HI: ${data.heat_index}°C` +
        ` | Smoke: ${data.smoke_status} | Env: ${data.environment_status}` +
        ` | stored (${reason})`,
    );

    // ---- Write to InfluxDB ----
    const point = new Point("sensor_environment")
      .floatField("temperature", data.temperature)
      .floatField("humidity", data.humidity)
      .floatField("heat_index", data.heat_index)
      .tag("smoke_status", data.smoke_status)
      .tag("temp_status", data.temp_status)
      .tag("environment_status", data.environment_status)
      .timestamp(timestamp);
    // The two legacy fields are still written so existing queries, charts and reports
    // keep working. Only written when that channel reported: a disabled channel must
    // leave a gap, not a zero, or averages come out halved.
    if (legacy.mq2_1_ppm != null) point.floatField("mq2_1_ppm", legacy.mq2_1_ppm);
    if (legacy.mq2_2_ppm != null) point.floatField("mq2_2_ppm", legacy.mq2_2_ppm);
    // The aggregate the dashboard tile and the alert rules judge — max across every wired
    // sensor, so a third or fourth one counts without every consumer learning a new field name.
    if (worst) point.floatField("gas_ppm", worst.ppm);

    // One point per sensor, tagged by channel (like server_volumes per mount), so a
    // third sensor is a new series instead of a schema change.
    const gasPoints = data.__gas.map((g) =>
      new Point("sensor_gas")
        .tag("channel", String(g.channel))
        .floatField("ppm", g.ppm)
        .timestamp(timestamp),
    );

    try {
      writeClient.writePoint(point);
      for (const gp of gasPoints) writeClient.writePoint(gp);
      await writeClient.flush();
    } catch (error) {
      console.error("[SENSOR] InfluxDB Error:", error);
    }

    // ---- On-site backup copy (independent of InfluxDB) ----
    // Inside the same check as the InfluxDB write, so the backup matches what was stored.
    backupService.record("env", {
      temperature: data.temperature,
      humidity: data.humidity,
      ...legacy,
      // The per-channel array too: the backup has to be able to restore what was stored, and
      // from 2026-09-17 what is stored includes sensors the two legacy slots cannot express.
      gas: data.__gas,
      heat_index: data.heat_index,
      smoke_status: data.smoke_status,
      temp_status: data.temp_status,
      environment_status: data.environment_status,
    });
  }

  // ---- Broadcast to dashboard ----
  try {
    socket.broadcast.volatile.emit("sensorData", {
      temperature: data.temperature,
      humidity: data.humidity,
      // Legacy pair kept so an open dashboard tab from before the cutover keeps rendering.
      ...legacy,
      // Per-sensor, with the label resolved here rather than in the browser — the label lives
      // in MySQL and the client has no reason to hold a second copy of it.
      gas: data.__gas.map((g) => ({ ...g, label: gasSensorService.labelFor(g.channel) })),
      gas_ppm: worst?.ppm ?? null,
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
