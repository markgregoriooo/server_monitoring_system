// WHEN an ESP32 reading is worth STORING. Not when it is worth acting on — every reading
// is still validated, broadcast live and evaluated against the alert rules at the full 3s
// cadence. This decides only what reaches InfluxDB and the on-site backup files.
//
// Why: the ESP32 sends every 3s (LOG_INTERVAL), which is right for the MQ-2 — smoke is a
// safety signal and detection latency matters — but wrong for the DHT11. That sensor has
// 1°C / 1% resolution and ±2°C accuracy, and a server room does not move 1°C in three
// seconds, so consecutive temperature samples differ by quantisation noise or not at all.
// At 3s the room stream costs ~28,800 samples/day: ~1.7 servers' worth of writes, and the
// same number of appends to the micro SD the backup writer lives on, which is the least
// reliable component in the build.
//
// Why report-by-exception and not simply "store temperature every 30s": storing gas-only
// points between the slow ones would leave most rows with a NULL temperature, and
// querySensorHistoryHandler aggregates into windows as small as 10s (-30m) / 20s (-1h)
// with createEmpty:false — windows holding no temperature sample would come back empty and
// gap the chart. Keeping every STORED point complete means the history path is untouched.
//
// So: store on a slow heartbeat, plus immediately whenever something actually happened. A
// stable room costs one point per 30s; a gas event is still captured within 3s, which is
// the part that matters. This is the standard SCADA/historian deadband pattern.
//
// PURE and import-free, like serverMetricUtils / historyRange / analyticsMath /
// linkAlertPolicy — so backend/tests can run it with no MySQL, InfluxDB or .env.

export const DEFAULTS = Object.freeze({
  /** Slow heartbeat: store at least this often even when nothing moves. 0 disables the
   *  whole policy and every reading is stored, which is the pre-existing behaviour. */
  intervalMs: 30_000,
  /** ppm. Above the MQ-2's clean-air noise, well under the seeded 150 ppm warning rule, so
   *  a genuine rise is captured on the 3s tick that first sees it. */
  gasDeadband: 15,
  /** °C. The DHT11 resolves 1°C, so anything it can actually report crosses this. */
  tempDeadband: 0.5,
  /** %RH. */
  humDeadband: 2,
});

// Returns the caller's fallback for null/undefined/""/non-finite. N-03.
const numOrFallback = (v, fallback) => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Read the policy out of a process.env-shaped object. Blank/absent → the defaults above. */
export function resolveOptions(env = {}) {
  return {
    intervalMs: Math.max(0, numOrFallback(env.ENV_PERSIST_INTERVAL_MS, DEFAULTS.intervalMs)),
    gasDeadband: Math.max(0, numOrFallback(env.ENV_PERSIST_DEADBAND_GAS, DEFAULTS.gasDeadband)),
    tempDeadband: Math.max(0, numOrFallback(env.ENV_PERSIST_DEADBAND_TEMP, DEFAULTS.tempDeadband)),
    humDeadband: Math.max(0, numOrFallback(env.ENV_PERSIST_DEADBAND_HUM, DEFAULTS.humDeadband)),
  };
}

const moved = (a, b, deadband) =>
  typeof a === "number" && typeof b === "number" && Math.abs(a - b) >= deadband;

/**
 * @param {object} sample  the reading, plus `at` (ms epoch)
 * @param {object|null} last  the last STORED reading, plus its `at`. null = nothing stored yet
 * @param {object} opts  from resolveOptions()
 * @returns {{persist: boolean, reason: string|null}} `reason` names the gate that fired, so
 *   a log line can say WHY a reading was kept — the same reason `npm run link:check` exists
 *   for link alerts: a policy whose normal outcome is silence is undebuggable without one.
 */
export function shouldPersist(sample, last, opts = DEFAULTS) {
  if (!sample) return { persist: false, reason: null };
  if (opts.intervalMs <= 0) return { persist: true, reason: "policy-disabled" };

  // Nothing stored yet: after a restart or a sensor reconnect, the first reading is the
  // only evidence of what the room was doing, and there is no baseline to compare against.
  if (!last) return { persist: true, reason: "first-reading" };

  if (sample.at - last.at >= opts.intervalMs) return { persist: true, reason: "heartbeat" };

  // A band transition is the whole point of the status fields — never smooth one away, or
  // the stored history would disagree with the alert that was raised from the same reading.
  if (sample.smoke_status !== last.smoke_status) return { persist: true, reason: "smoke_status" };
  if (sample.temp_status !== last.temp_status) return { persist: true, reason: "temp_status" };
  if (sample.environment_status !== last.environment_status) {
    return { persist: true, reason: "environment_status" };
  }

  // Gas first and per-sensor, not on the max of the two: one MQ-2 rising while the other
  // does not is exactly the disagreement two sensors exist to show.
  if (moved(sample.mq2_1_ppm, last.mq2_1_ppm, opts.gasDeadband)) return { persist: true, reason: "gas-1" };
  if (moved(sample.mq2_2_ppm, last.mq2_2_ppm, opts.gasDeadband)) return { persist: true, reason: "gas-2" };

  if (moved(sample.temperature, last.temperature, opts.tempDeadband)) return { persist: true, reason: "temperature" };
  if (moved(sample.humidity, last.humidity, opts.humDeadband)) return { persist: true, reason: "humidity" };

  return { persist: false, reason: null };
}

export default { DEFAULTS, resolveOptions, shouldPersist };
