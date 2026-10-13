import db from "../config/mysql.js";
import { audit } from "./auditService.js";
import { describeError } from "../utils/httpError.js";
import { isOpenAt, isOverdue, windowsInPeriod } from "./envMaintenanceRules.js";

// ─── Environment node maintenance ───────────────────────────────────────────────
// An admin opens a window before working on the ESP32 (unplugging it, opening the box,
// cleaning or swapping a sensor). While it is open:
//   • the room-level alerts are not raised — `esp32_offline` (esp32Monitor) and the
//     temperature / humidity / smoke rules (sensorHandler) — since the readings are
//     known to be wrong;
//   • auto-cooling is paused: the ESP32 is sent an `irConfig` with every channel off,
//     so a bogus reading cannot re-target the aircon. Manual on/off still works — the
//     firmware's `irCommand` does not consult that list;
//   • live readings still stream, so staff can watch the work.
// Every window ends on its own (`ends_at`) — the room has no alarm while one is open,
// so a forgotten Resume must not leave it that way. Rules in envMaintenanceRules.js.
//
// The open window is cached in memory (it is read on every 3s reading) and reloaded
// from MySQL at startup, so a restart neither forgets a window nor resurrects an
// expired one. Audit rows use module `devices` (the ESP32 is a device; no enum change).

let _io = null;
let current = null; // the open row, or null
let timer = null;
const endedListeners = [];

const SELECT = `
  SELECT m.*, us.name AS started_by_name, ue.name AS ended_by_name
    FROM environment_maintenance m
    LEFT JOIN users us ON us.user_id = m.started_by
    LEFT JOIN users ue ON ue.user_id = m.ended_by`;

const iso = (v) => (v == null ? null : new Date(v).toISOString());

export function isActive(now = Date.now()) {
  return isOpenAt(current, now);
}

// The shape the API and the `envMaintenance` broadcast both use.
export function getStatus() {
  if (!isActive()) return { active: false };
  return {
    active: true,
    id: current.id,
    startedAt: iso(current.started_at),
    endsAt: iso(current.ends_at),
    note: current.note ?? null,
    startedBy: current.started_by_name ?? null,
  };
}

// esp32Monitor registers here so it can raise its offline alert once a window closes
// with the box still silent. A listener, not an import, to avoid an import cycle.
export function onEnded(fn) {
  endedListeners.push(fn);
}

async function loadOpen() {
  const [rows] = await db.query(`${SELECT} WHERE m.ended_at IS NULL ORDER BY m.id DESC`);
  return rows;
}

async function reloadCurrent() {
  const rows = await loadOpen();
  current = rows.find((r) => isOpenAt(r)) ?? null;
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!isActive()) return;
  const wait = Math.max(0, new Date(current.ends_at).getTime() - Date.now());
  timer = setTimeout(() => {
    expire().catch((e) => console.error("[ENV_MAINT] expire failed:", describeError(e)));
  }, wait + 50);
  timer.unref?.();
}

// The ESP32's auto-cooling list. During a window every channel is reported OFF, so the
// firmware's handleIR fires nothing; outside one it is the real per-unit state.
async function pushIrConfig() {
  if (!_io) return;
  try {
    // Imported here, not at the top: airconService imports this module to mask its
    // channel list, and a static import both ways is a cycle.
    const { default: airconService } = await import("./airconService.js");
    _io.to("devices").emit("irConfig", await airconService.getChannelConfig());
  } catch (err) {
    console.error("[ENV_MAINT] irConfig push failed:", describeError(err));
  }
}

async function announce({ ended }) {
  if (_io) _io.emit("envMaintenance", getStatus());
  await pushIrConfig();
  if (ended) {
    for (const fn of endedListeners) {
      try {
        await fn();
      } catch (err) {
        console.error("[ENV_MAINT] end listener failed:", describeError(err));
      }
    }
  }
}

const describe = (row) => (row?.note ? ` (${row.note})` : "");
const fmtMin = (m) => (m % 60 === 0 ? `${m / 60} h` : `${m} min`);

// Open a window, or extend the open one to `minutes` from now.
export async function start({ minutes, note, userId, ip = null, userAgent = null }) {
  const now = new Date();
  const endsAt = new Date(now.getTime() + minutes * 60000);
  const extending = isActive();

  if (extending) {
    await db.query(
      `UPDATE environment_maintenance SET ends_at = ?, note = COALESCE(?, note) WHERE id = ?`,
      [endsAt, note, current.id],
    );
  } else {
    await db.query(
      `INSERT INTO environment_maintenance (started_at, ends_at, note, started_by) VALUES (?, ?, ?, ?)`,
      [now, endsAt, note, userId],
    );
  }
  await reloadCurrent();
  schedule();

  await audit({
    userId,
    module: "devices",
    action: extending ? "env_maintenance_extended" : "env_maintenance_started",
    description: extending
      ? `Environment node maintenance extended by ${fmtMin(minutes)} from now${describe(current)}`
      : `Environment node put in maintenance for ${fmtMin(minutes)}${describe(current)} — room alerts and auto-cooling paused`,
    level: "warning",
    ip,
    userAgent,
  });
  console.log(`[ENV_MAINT] ${extending ? "extended" : "started"} until ${endsAt.toISOString()}${describe(current)}`);

  await announce({ ended: false });
  return getStatus();
}

// Close the open window early (Resume). Idempotent: nothing open = nothing to do.
export async function end({ userId, ip = null, userAgent = null }) {
  if (!isActive()) return getStatus();
  const row = current;
  await db.query(
    `UPDATE environment_maintenance SET ended_at = ?, end_reason = 'resumed', ended_by = ? WHERE id = ?`,
    [new Date(), userId, row.id],
  );
  current = null;
  schedule();
  await audit({
    userId,
    module: "devices",
    action: "env_maintenance_ended",
    description: `Environment node maintenance ended${describe(row)} — room alerts and auto-cooling resumed`,
    ip,
    userAgent,
  });
  console.log("[ENV_MAINT] ended by user");
  await announce({ ended: true });
  return getStatus();
}

// The scheduled end arrived. Closed AT `ends_at`, not at "now", so a window that
// expired while the backend was down records the end it actually had.
async function expire() {
  const rows = await loadOpen();
  const now = Date.now();
  let closed = 0;
  for (const r of rows) {
    if (!isOverdue(r, now)) continue;
    await db.query(
      `UPDATE environment_maintenance SET ended_at = ends_at, end_reason = 'expired' WHERE id = ? AND ended_at IS NULL`,
      [r.id],
    );
    closed++;
    await audit({
      userId: null,
      module: "devices",
      action: "env_maintenance_expired",
      description: `Environment node maintenance ended on schedule${describe(r)} — room alerts and auto-cooling resumed`,
    });
  }
  const wasActive = current != null;
  await reloadCurrent();
  schedule();
  if (closed > 0) console.log(`[ENV_MAINT] ${closed} window(s) expired on schedule`);
  if (wasActive && !isActive()) await announce({ ended: true });
}

// Windows overlapping a report period, clipped to it (see windowsInPeriod).
export async function listInPeriod(start, end) {
  const [rows] = await db.query(
    `${SELECT} WHERE m.started_at < ? AND (m.ended_at IS NULL OR m.ended_at > ?) ORDER BY m.started_at`,
    [new Date(end), new Date(start)],
  );
  return windowsInPeriod(rows, start, end);
}

// Once at startup: close anything that expired while the backend was down, then
// re-arm the timer for a window that is still open.
export async function init(io) {
  _io = io;
  try {
    await expire();
    if (isActive()) {
      console.log(`[ENV_MAINT] window open until ${iso(current.ends_at)}${describe(current)}`);
    }
  } catch (err) {
    // Missing table (migration not applied): run without the feature rather than fail boot.
    console.error("[ENV_MAINT] init failed — maintenance mode unavailable:", describeError(err));
    current = null;
  }
}

export default { init, isActive, getStatus, start, end, onEnded, listInPeriod };
