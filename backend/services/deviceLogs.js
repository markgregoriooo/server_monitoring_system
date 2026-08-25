import db from "../config/mysql.js";
import { describeError } from "../utils/httpError.js";

// ─── Device event log (device_logs) ───────────────────────────────────────────
//
// Split out of agentService, which was the single most coupled module in the backend
// (Ca=11, Ce=7). Two of its three responsibilities were dragging every consumer along
// with them: the SNMP poller, the MikroTik poller, deviceAlerts, serverMetricsHandler
// and three route files all imported the whole of agentService — enrollment, the offline
// sweep, threshold evaluation and its four alerting dependencies — to call one of these
// two functions.
//
// This module needs only the database, so it is cheap for anything to depend on.
// See audits/code-complexity-report-2026-08-25.md — C-03.

/**
 * Best-effort insert of one device event. Returns the row shape for a live emit, or
 * null on failure.
 *
 * Deliberately swallows its error: writing a log line must never break the metric POST
 * or poll cycle that produced it.
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

export default { logDevice, getDeviceLogs };
