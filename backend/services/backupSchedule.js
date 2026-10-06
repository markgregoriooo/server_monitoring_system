// ─── Weekly backup: schedule + retention rules (PURE) ─────────────────────────
// Import-free, like serverMetricUtils/historyRange, so tests/backupSchedule.test.js runs
// with no MySQL, InfluxDB or .env.
//
// Everything here is in PHILIPPINE time (UTC+8, no daylight saving), whatever the
// server's own clock zone is. "Sunday 02:00" means 02:00 in Manila: the same rule as
// reportTemplate.formatPH — shift the instant by +8h, then read it back with the UTC
// getters. The local getters would add the machine's own offset on top and only be
// right on a server already set to Manila.

const PH_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** ICTU's answer: Sunday 02:00, keep 12 weeks. */
export const SCHEDULE_DEFAULTS = Object.freeze({ day: 0, time: "02:00", keepWeeks: 12 });
export const KEEP_WEEKS_MIN = 1;
export const KEEP_WEEKS_MAX = 52;

/** Calendar fields of `date` as read on a wall clock in Manila. */
export function phParts(date) {
  const d = new Date(date.getTime() + PH_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    dow: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/** "2026-10-11" — the Manila calendar date of an instant. */
export function phDate(date) {
  const p = phParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The instant at which Manila's wall clock reads y-m-d hh:mm. */
function phInstant(year, month, day, hour, minute) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - PH_OFFSET_MS);
}

/** "02:00" → { hour: 2, minute: 0 }, or null. */
export function parseTime(text) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text ?? "").trim());
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/**
 * Validate a schedule an admin submitted. Returns { value } or { error } — the route
 * answers 400 with the error, so a typo is refused rather than silently "fixed".
 */
export function validateSchedule(input) {
  const day = Number(input?.day);
  if (!Number.isInteger(day) || day < 0 || day > 6) return { error: "Day must be Sunday to Saturday." };
  const t = parseTime(input?.time);
  if (!t) return { error: "Time must be HH:MM, 24-hour (e.g. 02:00)." };
  const keepWeeks = Number(input?.keepWeeks);
  if (!Number.isInteger(keepWeeks) || keepWeeks < KEEP_WEEKS_MIN || keepWeeks > KEEP_WEEKS_MAX) {
    return { error: `Weeks to keep must be ${KEEP_WEEKS_MIN}-${KEEP_WEEKS_MAX}.` };
  }
  const time = `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
  return { value: { day, time, keepWeeks } };
}

/**
 * A schedule read back from the settings table. Never throws and never rejects: a row
 * edited by hand into nonsense falls back to the defaults field by field, so a bad
 * value cannot stop backups from being taken at all.
 */
export function normalizeSchedule(raw) {
  const day = Number(raw?.day);
  const keepWeeks = Number(raw?.keepWeeks);
  const t = parseTime(raw?.time);
  return {
    day: Number.isInteger(day) && day >= 0 && day <= 6 ? day : SCHEDULE_DEFAULTS.day,
    time: t
      ? `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`
      : SCHEDULE_DEFAULTS.time,
    keepWeeks:
      Number.isInteger(keepWeeks) && keepWeeks >= KEEP_WEEKS_MIN && keepWeeks <= KEEP_WEEKS_MAX
        ? keepWeeks
        : SCHEDULE_DEFAULTS.keepWeeks,
  };
}

/**
 * The most recent scheduled slot at or before `now` — the run that should already
 * have happened. The scheduler compares it with the slots already recorded, which is
 * what makes a missed run (backend down at 02:00 on Sunday) catch up on the next start.
 */
export function lastSlotAtOrBefore(now, schedule) {
  const { day, time } = normalizeSchedule(schedule);
  const { hour, minute } = parseTime(time);
  const p = phParts(now);
  const back = (p.dow - day + 7) % 7;
  let slot = phInstant(p.year, p.month, p.day - back, hour, minute);
  if (slot.getTime() > now.getTime()) slot = new Date(slot.getTime() - WEEK_MS);
  return slot;
}

/** The next scheduled slot strictly after `now`. */
export function nextSlotAfter(now, schedule) {
  return new Date(lastSlotAtOrBefore(now, schedule).getTime() + WEEK_MS);
}

/**
 * ISO-8601 week label of an instant, read in Manila: "2026-W41". The ISO year can
 * differ from the calendar year around New Year (2027-01-01 is in 2026-W53), which is
 * why it is computed from the week's Thursday and not taken from the date.
 */
export function isoWeekLabel(date) {
  const p = phParts(date);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dow = d.getUTCDay() || 7; // Monday=1 … Sunday=7
  d.setUTCDate(d.getUTCDate() + 4 - dow); // the Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(isoYear, 0, 1)) / DAY_MS + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * The seven whole days a backup taken at `runAt` covers: the seven Manila dates before
 * the run's own date. Today's file is still being written, so it belongs to next week's
 * backup — taking a half-day of it would put the same hours in two archives.
 * Returns { from, to } as inclusive "YYYY-MM-DD" strings.
 */
export function coverageFor(runAt) {
  const p = phParts(runAt);
  const toDate = new Date(Date.UTC(p.year, p.month - 1, p.day - 1));
  const fromDate = new Date(Date.UTC(p.year, p.month - 1, p.day - 7));
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { from: fmt(fromDate), to: fmt(toDate) };
}

/** Day-stamped data files ("env-2026-10-05.ndjson") inside an inclusive coverage window. */
export function filesInCoverage(names, { from, to }) {
  return names
    .filter((n) => {
      const m = /^[a-z0-9]+-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(n);
      return m && m[1] >= from && m[1] <= to;
    })
    .sort();
}

/**
 * Which finished backups retention should remove: anything older than `keepWeeks`
 * weeks. Two guards, because this deletes the very thing a backup module exists to keep:
 *   - the NEWEST successful backup is never removed, however old — after a long outage
 *     the oldest archive may be the only good one left;
 *   - a backup still running, or one that failed (it has no file), is not touched.
 *
 * @param {{id:number, status:string, finishedAt:Date|string|null}[]} rows
 * @returns {number[]} ids to purge
 */
export function selectExpired(rows, now, keepWeeks) {
  const cutoff = now.getTime() - normalizeSchedule({ keepWeeks }).keepWeeks * WEEK_MS;
  const ok = rows
    .filter((r) => r.status === "ok" && r.finishedAt)
    .map((r) => ({ ...r, t: new Date(r.finishedAt).getTime() }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => b.t - a.t);
  return ok.slice(1).filter((r) => r.t < cutoff).map((r) => r.id);
}

/** Archive file names this module writes — the only names a download will ever serve. */
export const ARCHIVE_NAME_RE = /^(weekly-\d{4}-W\d{2}|manual-\d{4}-\d{2}-\d{2}-\d{4,6})\.tar\.gz\.enc$/;

/** "weekly-2026-W41.tar.gz.enc" / "manual-2026-10-06-143205.tar.gz.enc". */
export function archiveName(kind, runAt) {
  if (kind === "weekly") return `weekly-${isoWeekLabel(runAt)}.tar.gz.enc`;
  const p = phParts(runAt);
  const d = new Date(runAt.getTime() + PH_OFFSET_MS);
  const hms = [p.hour, p.minute, d.getUTCSeconds()].map((n) => String(n).padStart(2, "0")).join("");
  return `manual-${phDate(runAt)}-${hms}.tar.gz.enc`;
}

export default {
  DAY_NAMES,
  SCHEDULE_DEFAULTS,
  phParts,
  phDate,
  parseTime,
  validateSchedule,
  normalizeSchedule,
  lastSlotAtOrBefore,
  nextSlotAfter,
  isoWeekLabel,
  coverageFor,
  filesInCoverage,
  selectExpired,
  archiveName,
  ARCHIVE_NAME_RE,
};
