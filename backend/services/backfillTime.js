// WHEN a timestamp sent by the ESP32 can be trusted enough to write into history.
//
// This only matters for backfill. A LIVE reading is stamped by the backend with
// `new Date()` — it arrives milliseconds after it was taken, so the device's own clock
// is irrelevant and drift cannot hurt anything. A reading replayed from the micro SD is
// the opposite case: it was taken minutes or hours ago and the ESP32 is the only thing
// that knows when, so its clock becomes load-bearing. That is the whole reason the
// DS3231 needs its coin cell.
//
// The failure this guards is specific and quiet. `rtc.lostPower()` is true exactly when
// the coin cell is dead, and the firmware answers it with
// `rtc.adjust(DateTime(F(__DATE__), F(__TIME__)))` — the date the firmware was BUILT.
// That is a perfectly well-formed date attached to readings that were never taken then.
// Written to InfluxDB it does not look like an error; it looks like history, sitting
// wherever the build date happens to fall. Losing those rows is much better than
// believing them, so an implausible timestamp is refused rather than clamped.
//
// PURE and import-free, like envPersistPolicy / linkAlertPolicy / serverMetricUtils, so
// backend/tests runs it with no MySQL, InfluxDB or .env.

/** The firmware sets its clock with `configTime(8 * 3600, 0, ...)` — Philippine time,
 *  no DST — and formats "YYYY-MM-DD HH:MM:SS" with no offset in the string. Parsing
 *  that with a bare `new Date(...)` adopts the BACKEND's timezone instead, so the same
 *  card replayed on a UTC machine would land every row 8 hours early. Pinning it here
 *  keeps a reading where it was actually taken, whatever the server is set to.
 *  ⚠️ Must match the firmware's configTime offset. */
export const DEVICE_UTC_OFFSET = "+08:00";

/** Ahead of now by more than this = a clock fault, not a late arrival. */
export const MAX_FUTURE_MS = 5 * 60 * 1000;

/** Behind now by more than this = almost certainly the build-date fallback above.
 *  Also the practical ceiling on a believable outage: the buffer is sized in weeks. */
export const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const NAKED_LOCAL = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/;

/**
 * @param {string} raw  the device's `timestamp` field
 * @param {number} nowMs  ms epoch to judge against (injectable so tests don't drift)
 * @returns {{at: Date|null, reason: string}} `reason` names the gate that fired, the
 *   same way envPersistPolicy and linkAlertPolicy do: a policy whose normal outcome is
 *   silence cannot be debugged from a log that only says "dropped".
 */
export function parseDeviceTime(raw, nowMs = Date.now()) {
  if (typeof raw !== "string") return { at: null, reason: "unparseable" };
  const s = raw.trim();
  if (s === "") return { at: null, reason: "unparseable" };

  // getTimestamp()'s last-resort format when neither the RTC nor NTP could answer.
  // The firmware refuses to buffer these, so one arriving means an ESP32 on older
  // firmware — worth naming separately from a corrupt string.
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
