// Whether a timestamp from the ESP32 can be trusted for backfill.
//
// Live readings are stamped by the backend, so the device clock does not matter.
// Readings replayed from the SD card use the device's time. With a dead RTC coin cell
// the firmware sets the clock to its build date, which gives valid-looking but wrong
// timestamps, so implausible ones are refused rather than clamped. No imports, so it
// is unit-tested.

/**
 * The firmware uses Philippine time (configTime(8 * 3600, ...)) and sends
 * "YYYY-MM-DD HH:MM:SS" with no offset. Parse it as +08:00 so the result does not
 * depend on the server's timezone. Must match the firmware's configTime offset.
 */
export const DEVICE_UTC_OFFSET = "+08:00";

/** Ahead of now by more than this = a clock fault, not a late arrival. */
export const MAX_FUTURE_MS = 5 * 60 * 1000;

/** Behind now by more than this = almost certainly the build-date fallback above.
 *  Also the practical ceiling on a believable outage: the buffer is sized in weeks. */
export const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const NAKED_LOCAL = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/;

/**
 * @param {string} raw  the device's `timestamp` field
 * @param {number} nowMs  ms epoch to judge against (injectable for tests)
 * @returns {{at: Date|null, reason: string}} `reason` names the check that fired.
 */
export function parseDeviceTime(raw, nowMs = Date.now()) {
  if (typeof raw !== "string") return { at: null, reason: "unparseable" };
  const s = raw.trim();
  if (s === "") return { at: null, reason: "unparseable" };

  // getTimestamp()'s fallback when neither the RTC nor NTP was available. Current
  // firmware does not buffer these, so one arriving means older firmware.
  if (s.startsWith("UP ")) return { at: null, reason: "no-clock" };

  const iso = NAKED_LOCAL.test(s) ? `${s.replace(" ", "T")}${DEVICE_UTC_OFFSET}` : s;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { at: null, reason: "unparseable" };

  const age = nowMs - at.getTime();
  if (age < -MAX_FUTURE_MS) return { at: null, reason: "future" };
  if (age > MAX_AGE_MS) return { at: null, reason: "stale" };

  return { at, reason: "ok" };
}

export default { parseDeviceTime, DEVICE_UTC_OFFSET, MAX_FUTURE_MS, MAX_AGE_MS };
