import db from "../config/mysql.js";
import { describeError } from "../utils/httpError.js";

// ─── Device event log (device_logs) ───────────────────────────────────────────
// Moved out of agentService so the pollers and routes can log without importing
// all of agentService. Only needs the database.
// See audits/code-complexity-report-2026-08-25.md (C-03).

/**
 * Insert one device event. Returns the row for a live emit, or null on failure.
 * Errors are swallowed so logging never breaks a metric POST or a poll.
 */
export async function logDevice(deviceId, level, message) {
  try {
    await db.query(`INSERT INTO device_logs (device_id, log_level, message) VALUES (?, ?, ?)`, [
      deviceId,
      level,
      message,
    ]);
    return { device_id: Number(deviceId), log_level: level, message, recorded_at: new Date().toISOString() };
  } catch (err) {
    console.error("[device_logs] insert error:", describeError(err));
    return null;
  }
}

/** Most recent events for one device, newest first. `limit` is clamped to 1–200. */
export async function getDeviceLogs(deviceId, limit = 50) {
  const n = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const [rows] = await db.query(
    `SELECT log_level, message, recorded_at
       FROM device_logs
      WHERE device_id = ?
      ORDER BY recorded_at DESC, device_log_id DESC
      LIMIT ${n}`,
    [deviceId],
  );
  return rows;
}

/**
 * Delete device events older than `days` (default 90). Returns the number removed.
 * Normally only a few rows a day, but a flapping port writes one per change.
 * Longer than alerts (30d), shorter than system_logs (365d).
 */
export async function purgeOld(days) {
  const [res] = await db.query(
    `DELETE FROM device_logs WHERE recorded_at < (NOW() - INTERVAL ? DAY)`,
    [Number(days) || 90],
  );
  return res.affectedRows ?? 0;
}

export default { logDevice, getDeviceLogs, purgeOld };
