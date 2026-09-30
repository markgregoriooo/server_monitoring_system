// How serious it is that the offsite (Backblaze) backup has stopped. The rclone job
// writes a marker after every successful upload, and this looks at its age:
//
//   older than warnHours (26)  → WARNING (bell + toast). Usually one missed night
//                                due to a campus internet blip; the next run catches up.
//   older than critHours (72)  → CRITICAL, which is emailed by default. Three missed
//                                nights means the job is broken.
//
// critHours = 0 turns off escalation. A critHours at or below warnHours is raised to
// warnHours. A missing marker means "never synced" and is critical right away when
// escalation is on. No imports, so it is unit-tested.

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
