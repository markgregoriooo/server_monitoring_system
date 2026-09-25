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

// How often a reading is STORED (see services/envPersistPolicy.js). Everything else in
// this handler still runs at the ESP32's full 3s cadence — validation, the heartbeat, the
// live broadcast and the alert evaluation are all untouched.
const PERSIST_OPTS = envPersistPolicy.resolveOptions(process.env);

// The last reading actually written. Module-level, NOT on the socket: the ESP32 gets a new
// socket on every reconnect, and a per-socket baseline would make the first reading after
// each brief drop look like a fresh start. (A long outage still stores immediately — the
// heartbeat gate compares timestamps, so a gap longer than the interval always passes.)
let lastPersisted = null;

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
// `d.__gas` is the normalised per-channel array, attached once per reading in sensorHandler
// so the rules, the write, the backup and the broadcast all judge the same numbers.
const ENV_METRICS = {
  temperature: { value: (d) => d.temperature, unit: "°C", label: "Server room temperature" },
  // MAX across the wired sensors, not the mean — see gasReadings.worstGas. Null when no
  // channel reported, which skips the metric rather than evaluating 0 ppm and resolving a
  // smoke alert on no evidence.
  gas: { value: (d) => worstGas(d.__gas ?? [])?.ppm ?? null, unit: "ppm", label: "Server room gas" },
  humidity: { value: (d) => d.humidity, unit: "%", label: "Server room humidity" },
};

/**
 * Resolve the band to ACT on for one room metric, applying recovery confirmation.
 *
 * Recovery needs CONFIRMATION — see agentService.checkThresholds. It matters most for
 * GAS: the MQ-2 is an analog sensor with genuinely noisy readings, so a single dip below
 * the threshold is weak evidence the smoke has cleared. This only ever delays the
 * ALL-CLEAR — escalation stays instant, so the fail-safe direction is preserved for a
 * smoke alarm.
 *
 * Extracted from the loop in maybeRaiseEnvAlert, where it was the depth-4 branch in one
 * of only two functions in the codebase that nest that deep. It is also the subtle,
 * safety-relevant part, so it is worth being a named thing that can be tested on its own.
 * See audits/code-complexity-report-2026-08-25.md — C-06.
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

      // Smoke = a gas reading the firmware flags CRITICAL — give it a clearer title.
      // "DANGER" is what firmware before 2026-08-15 called that same band; accepted so
      // the title doesn't quietly degrade to the generic one on an ESP32 that hasn't been
      // reflashed yet. Safe to drop once every device is on the current sketch.
      const smoke =
        key === "gas" &&
        (data.smoke_status === "CRITICAL" || data.smoke_status === "DANGER");
      const word = band === "critical" ? "critical" : band === "warning" ? "high" : band;

      // WHICH sensor. Two MQ-2s are only worth having if they sit apart — over the rack and
      // over the UPS cabinet, say — and at that point "gas critical: 412 ppm" does not tell
      // anyone which end of the room to run to. Named from the worst channel, since that is
      // the reading the band was decided on.
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
    // Gas is deliberately NOT required here any more. It arrives either as `gas_ppm[]` (new
    // firmware) or as mq2_1/mq2_2 (old), and how many channels are populated is a property of
    // the wiring, not of a valid reading — normalizeGas sorts that out below. Demanding two
    // numeric fields would reject a 4-sensor device outright.
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

  // Resolve the per-channel gas readings ONCE, here, and hang them off the payload. The
  // rules, the InfluxDB write, the backup copy and the broadcast must all judge the same
  // numbers; re-deriving them at four call sites is how they drift.
  // Channels an admin has not confirmed are wired are dropped — a floating ADC pin reads
  // noise, not zero, and MQ-2 noise through an exponential curve looks like a real ppm.
  data.__gas = normalizeGas(data, gasSensorService.enabledChannels());
  const legacy = legacyFields(data.__gas);   // mq2_1_ppm / mq2_2_ppm, for everything written
                                             // against the two-sensor shape
  const worst = worstGas(data.__gas);

  const timestamp = new Date();   // precision: ms (matches writeClient config)

  // ---- Store, or not ----
  // The DHT22 resolves 0.1°C and a server room does not move measurably in three seconds, so most
  // readings carry no information the last one didn't. Store on a slow heartbeat plus
  // whenever something actually moved — a gas rise, a status transition, a real temperature
  // excursion — which keeps a smoke event captured on the 3s tick that first sees it while
  // a stable room costs one point per 30s instead of ten. See services/envPersistPolicy.js.
  // envPersistPolicy judges gas on the two legacy slots, which is still right: its job is
  // "did anything move enough to be worth storing", and the deadband is per-sensor. Channels
  // 3+ are folded in via gas_ppm so a rise on a NEW sensor still forces a store rather than
  // waiting for the 30s heartbeat — the one case where missing a tick matters.
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
    // The two legacy slots are still written, so every query, chart and report built against
    // `mq2_1_ppm` / `mq2_2_ppm` keeps working across the cutover and keeps reading old history
    // unchanged. Only written when that channel actually reported — a disabled channel 2 must
    // leave a GAP, not a zero, or `mean()` over the range quietly halves the room's gas level.
    if (legacy.mq2_1_ppm != null) point.floatField("mq2_1_ppm", legacy.mq2_1_ppm);
    if (legacy.mq2_2_ppm != null) point.floatField("mq2_2_ppm", legacy.mq2_2_ppm);
    // The aggregate the dashboard tile and the alert rules judge — max across every wired
    // sensor, so a third or fourth one counts without every consumer learning a new field name.
    if (worst) point.floatField("gas_ppm", worst.ppm);

    // One point PER SENSOR, tagged by channel — the same shape as `server_volumes` per mount
    // and `network_traffic` per interface. This is what makes a 3rd sensor a row in a table
    // rather than a schema change, and what lets a chart draw one line per location.
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
    // Deliberately inside the same gate: the backup is a second copy of what was stored,
    // and letting the two diverge would make it useless for restoring the database.
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
