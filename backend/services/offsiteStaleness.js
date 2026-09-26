// HOW LOUDLY to complain that the offsite (Backblaze) backup has stopped.
//
// The rclone job stamps a marker on every successful upload; the backend reads its age.
// Two thresholds, because one missed night and a week of them are different problems:
//
//   older than warnHours (26)  → WARNING  — bell + toast. One missed 2:30 AM run, usually
//                                a campus internet blip, and the next night's `rclone
//                                copy` uploads whatever was missed. Emailing it would
//                                teach people to ignore backup mail.
//   older than critHours (72)  → CRITICAL — which is what reaches EMAIL
//                                (NOTIFY_EMAIL_MIN_SEVERITY defaults to critical). Three
//                                missed nights is a broken job, and a broken backup is
//                                invisible until the day it is needed — the bell alone
//                                only helps if someone opens the dashboard.
//
// critHours = 0 turns the escalation off (warning only, the old behaviour). A critHours
// at or below warnHours is lifted to warnHours, so the two simply fire together rather
// than critical firing on a fresher marker than the warning does.
//
// A missing / unreadable marker (stampMs null) means "never synced": that is CRITICAL at
// once only if escalation is on — it is what an enabled check with no working job looks
// like, and waiting 72 h to say so would hide a job that was never set up.
//
// PURE and import-free, like envPersistPolicy / linkAlertPolicy, so backend/tests runs it
// with no MySQL, InfluxDB or .env.

const HOUR_MS = 60 * 60 * 1000;

export const DEFAULT_WARN_HOURS = 26;
export const DEFAULT_CRIT_HOURS = 72;

/** Parse the two env values into effective hours. critHours 0 = escalation disabled. */
export function resolveThresholds(warnRaw, critRaw) {
  const w = Number(warnRaw);
  const warnHours = Number.isFinite(w) && w > 0 ? w : DEFAULT_WARN_HOURS;
  const blank = critRaw == null || String(critRaw).trim() === "";
  const c = Number(critRaw);
  let critHours = blank || !Number.isFinite(c) || c < 0 ? DEFAULT_CRIT_HOURS : c;
  if (critHours > 0 && critHours < warnHours) critHours = warnHours;
  return { warnHours, critHours };
}

/**
 * @returns {"ok" | "warning" | "critical"}
 */
export function offsiteSeverity(stampMs, nowMs, { warnHours, critHours }) {
  const escalate = critHours > 0;
  if (stampMs == null || !Number.isFinite(stampMs)) return escalate ? "critical" : "warning";
  const age = nowMs - stampMs;
  if (escalate && age > critHours * HOUR_MS) return "critical";
  if (age > warnHours * HOUR_MS) return "warning";
  return "ok";
}
