// PURE, import-free rules for the environment node's maintenance windows, kept apart from
// envMaintenanceService (the MySQL / timer / socket half) so tests/envMaintenanceRules.test.js
// runs with no database. Same split as backupSchedule / systemBackupService.

// The only lengths an admin can choose. Fixed, short choices on purpose: while a window
// is open the server room has no smoke or heat alarm, so "until I say so" is not offered
// and nothing longer than four hours either. Work that runs longer is extended, which is
// a deliberate second click rather than a large number typed once.
export const DURATION_MINUTES = Object.freeze([30, 60, 120, 240]);

export const NOTE_MAX = 200;

const err = (message) => ({ ok: false, error: message });

// Validate a start/extend request body. Returns { ok, minutes, note } or { ok:false, error }.
export function parseStartRequest(body) {
  const minutes = Number(body?.minutes);
  if (!DURATION_MINUTES.includes(minutes)) {
    return err(`minutes must be one of ${DURATION_MINUTES.join(", ")}.`);
  }
  const raw = body?.note;
  if (raw != null && typeof raw !== "string") return err("note must be text.");
  const note = (raw ?? "").trim().replace(/\s+/g, " ");
  if (note.length > NOTE_MAX) return err(`note must be at most ${NOTE_MAX} characters.`);
  return { ok: true, minutes, note: note || null };
}

const ms = (v) => (v instanceof Date ? v.getTime() : v == null ? NaN : new Date(v).getTime());

// Is this window open at `now`? Closed by hand (`ended_at`) or past its scheduled end.
export function isOpenAt(win, now = Date.now()) {
  if (!win || win.ended_at != null) return false;
  const end = ms(win.ends_at);
  return Number.isFinite(end) && now < end;
}

// An open row whose scheduled end has already passed: it expired while nothing was
// running to close it (the backend was down), so startup closes it at `ends_at`.
export function isOverdue(win, now = Date.now()) {
  if (!win || win.ended_at != null) return false;
  const end = ms(win.ends_at);
  return Number.isFinite(end) && now >= end;
}

// Windows that overlap [start, end), each clipped to that period, for the Environment
// report. An open window counts up to `now` (it has not ended yet, and its scheduled
// end is a plan, not something that happened). Sorted oldest first.
export function windowsInPeriod(rows, start, end, now = Date.now()) {
  const s = ms(start);
  const e = ms(end);
  const out = [];
  for (const r of rows ?? []) {
    const from = ms(r.started_at);
    const until = r.ended_at != null ? ms(r.ended_at) : Math.min(ms(r.ends_at), now);
    if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) continue;
    if (until <= s || from >= e) continue;
    const a = Math.max(from, s);
    const b = Math.min(until, e);
    out.push({ ...r, clippedFrom: new Date(a), clippedTo: new Date(b), minutes: Math.round((b - a) / 60000) });
  }
  return out.sort((x, y) => x.clippedFrom - y.clippedFrom);
}
