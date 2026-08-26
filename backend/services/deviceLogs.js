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

/**
 * Delete device events older than `days`. Returns the number removed.
 *
 * `device_logs` was the last log table in the schema with no retention at all — `alerts`
 * (30 d), `reports` (90 d) and `system_logs` (365 d) all purge daily, and system_logs got
 * its purge for exactly this reason. The measured rate here is low (~1 row/day on a
 * healthy system, since these are lifecycle events and threshold CROSSINGS rather than
 * samples), so this is consistency rather than an emergency — but the rate is a property
 * of things going well. A flapping port or a metric oscillating around its threshold
 * writes a row per transition, and the table that records the incident should not be the
 * one that fills the disk during it.
 *
 * 90 days: longer than the alerts feed, because a device's own history is what you read
 * when investigating a repeat offender; shorter than system_logs, because this is
 * operational telemetry, not the compliance trail.
 */
export async function purgeOld(days) {
  const [res] = await db.query(
    `DELETE FROM device_logs WHERE recorded_at < (NOW() - INTERVAL ? DAY)`,
    [Number(days) || 90],
  );
  return res.affectedRows ?? 0;
}

export default { logDevice, getDeviceLogs, purgeOld };
