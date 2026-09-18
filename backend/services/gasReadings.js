/**
 * PURE, import-free helpers for the multi-sensor gas path.
 *
 * Import-free like serverMetricUtils / envPersistPolicy / analyticsMath, so `npm test` can
 * exercise it with no MySQL, no InfluxDB and no .env.
 *
 * ── The compatibility problem this exists to solve ──────────────────────────────────────
 * Gas used to be exactly two fields, `mq2_1_ppm` and `mq2_2_ppm`, hand-written into the
 * firmware payload, the validation, the InfluxDB write, the SD card's CSV, the backup NDJSON
 * and three frontend pages. Going to four sensors cannot mean breaking an ESP32 that has not
 * been reflashed yet — the boxes are in a ceiling, and "reflash everything first" is how a
 * monitoring system goes dark during its own upgrade.
 *
 * So BOTH shapes are accepted, forever-ish:
 *   • new — `gas_ppm: [38.2, 41.0, 36.7, null]`, index+1 = channel
 *   • old — `mq2_1_ppm` / `mq2_2_ppm`
 * and both are WRITTEN, so an old dashboard and an old query keep reading what they expect
 * while the new per-sensor series fills in beside them. Same reasoning as the deprecated
 * `deviceKey` query fallback in the socket handshake: the migration ends when the last device
 * is reflashed, not when the code lands.
 */

/**
 * Normalise a reading into per-channel entries.
 *
 * ⚠️ `enabled` is a SAFETY gate, not a view filter. An ADC pin with no sensor attached floats
 * — it does not read zero, it reads noise, and MQ-2 noise pushed through an exponential curve
 * is a plausible-looking ppm. A channel nobody has confirmed is wired must not be able to
 * raise a smoke alarm, so an unknown channel is dropped rather than trusted.
 *
 * @param {object} data           the socket payload
 * @param {number[]} enabled      channels an admin has confirmed are wired (1-based)
 * @returns {{channel:number, ppm:number}[]} ascending by channel, non-finite values removed
 */
export function normalizeGas(data, enabled = []) {
  const allow = new Set(enabled.map(Number));
  const out = [];

  const push = (channel, raw) => {
    // ⚠️ Rejected BEFORE Number(), because `Number(null)` is 0 and `Number("")` is 0 — both
    // finite, both wrong. An unpopulated slot would have become a perfectly valid 0 ppm
    // reading, mirrored into the legacy field, and dragged every mean() over the range down.
    // A missing reading has to be a GAP, not a floor.
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
 * The single number the room is judged on.
 *
 * MAX, not mean — coverage logic. Two sensors are only worth having if they are in different
 * places, and then the question is "does ANY of them see smoke", not "what is the room's
 * average smokiness". Averaging four sensors would let one of them sit in a fire while the
 * other three dilute it below the threshold.
 *
 * Returns null when there is nothing to judge, so the caller can skip the metric rather than
 * evaluate 0 ppm and cheerfully resolve a smoke alert on no evidence.
 */
export function worstGas(readings) {
  let worst = null;
  for (const r of readings) {
    if (worst === null || r.ppm > worst.ppm) worst = r;
  }
  return worst;
}

/**
 * Legacy field mirror, so points written from a 4-sensor device stay readable by every query,
 * chart and report that was written against `mq2_1_ppm` / `mq2_2_ppm`. Channels above 2 have
 * nowhere to go here — they live in the per-channel series instead, which is the whole point.
 */
export function legacyFields(readings) {
  const fields = {};
  for (const r of readings) {
    if (r.channel === 1) fields.mq2_1_ppm = r.ppm;
    if (r.channel === 2) fields.mq2_2_ppm = r.ppm;
  }
  return fields;
}
