// When an ESP32 reading is worth storing. Every reading is still validated,
// broadcast and checked against the alert rules every 3s; this only decides what
// goes to InfluxDB and the backup files.
//
// The 3s rate suits the MQ-2 (smoke needs fast detection) but not the DHT22: the
// room does not change measurably in 3 seconds, and storing every reading is ~28,800
// points a day plus as many writes to the SD card.
//
// So: store on a slow heartbeat (30s), plus right away when gas rises, a status
// changes or temperature/humidity really moves (a deadband, as SCADA historians
// do). Every stored point keeps all fields, so the history charts need no changes.
// No imports, so it is unit-tested.

export const DEFAULTS = Object.freeze({
  /** Slow heartbeat: store at least this often even when nothing moves. 0 disables the
   *  whole policy and every reading is stored, which is the pre-existing behaviour. */
  intervalMs: 30_000,
  /** ppm. Above the MQ-2's clean-air noise, well under the seeded 150 ppm warning rule, so
   *  a genuine rise is captured on the 3s tick that first sees it. */
  gasDeadband: 15,
  /**
   * °C. The DHT22 reads in 0.1°C steps, so this filters out jitter (above its ±0.5°C
   * accuracy) while keeping any real change.
   */
  tempDeadband: 0.5,
  /** %RH. Same reasoning as the temperature deadband: the DHT22 resolves 0.1%RH, so this
   *  filters real jitter rather than sitting below what the sensor can express. */
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
 * @returns {{persist: boolean, reason: string|null}} `reason` names the check that fired,
 *   so a log line can say why a reading was kept.
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
  // Sensors 3 and 4 have no legacy field, so the worst-channel value covers them;
  // otherwise a rise on a new sensor would wait for the 30s heartbeat.
  if (moved(sample.gas_ppm, last.gas_ppm, opts.gasDeadband)) return { persist: true, reason: "gas" };

  if (moved(sample.temperature, last.temperature, opts.tempDeadband)) return { persist: true, reason: "temperature" };
  if (moved(sample.humidity, last.humidity, opts.humDeadband)) return { persist: true, reason: "humidity" };

  return { persist: false, reason: null };
}

export default { DEFAULTS, resolveOptions, shouldPersist };
