/**
 * Helpers for the multi-sensor gas readings, with no imports so they are unit-tested.
 *
 * Gas used to be two fixed fields, `mq2_1_ppm` and `mq2_2_ppm`. To support four
 * sensors without breaking an ESP32 that has not been reflashed, both shapes are
 * accepted:
 *   • new: `gas_ppm: [38.2, 41.0, 36.7, null]`, index+1 = channel
 *   • old: `mq2_1_ppm` / `mq2_2_ppm`
 * and both are written, so existing queries keep working while the per-sensor
 * series is added alongside.
 */

/**
 * Normalise a reading into per-channel entries. Channels not in `enabled` are
 * dropped: an unwired ADC pin reads noise that looks like a real ppm.
 *
 * @param {object} data           the socket payload
 * @param {number[]} enabled      channels an admin has marked as wired (1-based)
 * @returns {{channel:number, ppm:number}[]} ascending by channel, non-finite values removed
 */
export function normalizeGas(data, enabled = []) {
  const allow = new Set(enabled.map(Number));
  const out = [];

  const push = (channel, raw) => {
    // Checked before Number(), since Number(null) and Number("") are both 0. A missing
    // reading must be a gap, not 0 ppm.
    if (raw === null || raw === undefined || raw === "") return;
    const ppm = Number(raw);
    if (!Number.isFinite(ppm)) return;      // junk from a malformed payload
    if (!allow.has(channel)) return;
    out.push({ channel, ppm });
  };

  if (Array.isArray(data?.gas_ppm)) {
    data.gas_ppm.forEach((ppm, i) => push(i + 1, ppm));
  } else {
    // Legacy two-field firmware. Channels 1 and 2 by definition — that is what those two
    // field names have always meant, and the migration seeds them as channels 1 and 2.
    push(1, data?.mq2_1_ppm);
    push(2, data?.mq2_2_ppm);
  }

  return out.sort((a, b) => a.channel - b.channel);
}

/**
 * The one number the room is judged on: the max across sensors, not the mean, so
 * one sensor near smoke is not averaged away by the others. Null when there is
 * nothing to judge, so the caller skips the metric instead of reading 0 ppm.
 */
export function worstGas(readings) {
  let worst = null;
  for (const r of readings) {
    if (worst === null || r.ppm > worst.ppm) worst = r;
  }
  return worst;
}

/**
 * Legacy fields, so points from a 4-sensor device stay readable by everything
 * built on mq2_1_ppm / mq2_2_ppm. Channels above 2 only exist in the per-channel series.
 */
export function legacyFields(readings) {
  const fields = {};
  for (const r of readings) {
    if (r.channel === 1) fields.mq2_1_ppm = r.ppm;
    if (r.channel === 2) fields.mq2_2_ppm = r.ppm;
  }
  return fields;
}
