import db from "../config/mysql.js";
import notificationService from "./notificationService.js";
import alertBandState from "./alertBandState.js";

// ─── Alert lifecycle (the shared incident state, distinct from the per-user bell) ──
// alerts.status: 'active' → 'acknowledged' → 'resolved'.
//   acknowledge = manual ("I'm on it"): sets acknowledged_by + acknowledged_at.
//   resolve     = manual OR auto (metric recovered): sets resolved_at.
// This is ONE shared row per alert (everyone sees the same status), unlike
// alert_notifications.is_read which is per-user. `io` is injected once (init) so the
// recovery path + routes can broadcast `alertUpdated` without threading it through.

let _io = null;
function init(io) {
  _io = io;
}

function broadcast(alert) {
  if (_io && alert) _io.emit("alertUpdated", alert);
}

const VALID_STATUS = ["active", "acknowledged", "resolved"];

function toClient(r) {
  const iso = (v) => (v instanceof Date ? v.toISOString() : v);
  return {
    id: r.alert_id,
    deviceId: r.device_id,
    deviceName: r.device_name ?? null,
    alertRuleId: r.alert_rule_id,
    type: r.type,
    title: r.title,
    message: r.message,
    severity: r.severity,
    status: r.status,
    metricValue: r.metric_value,
    acknowledgedBy: r.acknowledged_by,
    acknowledgedByName: r.acknowledged_by_name ?? null,
    acknowledgedByRole: r.acknowledged_by_role ?? null,
    acknowledgedAt: iso(r.acknowledged_at),
    resolvedAt: iso(r.resolved_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const BASE_SELECT = `
  SELECT a.alert_id, a.device_id, a.alert_rule_id, a.type, a.title, a.message,
         a.severity, a.status, a.metric_value, a.acknowledged_by,
         a.acknowledged_at, a.resolved_at, a.created_at, a.updated_at,
         d.device_name, u.name AS acknowledged_by_name, u.role AS acknowledged_by_role
    FROM alerts a
    LEFT JOIN devices d ON d.device_id = a.device_id
    LEFT JOIN users u   ON u.user_id   = a.acknowledged_by`;

// Alert history, newest first. Optional status filter.
async function list({ status, limit = 100 } = {}) {
  const n = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const where = [];
  const params = [];
  if (status && VALID_STATUS.includes(status)) {
    where.push("a.status = ?");
    params.push(status);
  }
  const sql = `${BASE_SELECT}
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY a.created_at DESC, a.alert_id DESC
       LIMIT ${n}`;
  const [rows] = await db.query(sql, params);
  return rows.map(toClient);
}

async function getById(id) {
  const [[row]] = await db.query(`${BASE_SELECT} WHERE a.alert_id = ?`, [Number(id)]);
  return row ? toClient(row) : null;
}

// Count of alerts still needing attention (active OR acknowledged — i.e. not resolved).
// Drives the sidebar "Alerts" badge.
async function openCount() {
  const [[row]] = await db.query(`SELECT COUNT(*) AS c FROM alerts WHERE status <> 'resolved'`);
  return Number(row?.c ?? 0);
}

// Manual acknowledge — only meaningful from 'active'. Returns the alert (or null if
// it doesn't exist). A no-op transition (already ack'd/resolved) returns it unchanged.
async function acknowledge(id, userId) {
  const [res] = await db.query(
    `UPDATE alerts
        SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = NOW()
      WHERE alert_id = ? AND status = 'active'`,
    [userId, Number(id)],
  );
  // The actor has clearly seen it → mark their own bell row read (only theirs).
  await notificationService.markReadByAlert(userId, id);
  const alert = await getById(id);
  if (res.affectedRows) broadcast(alert);
  return alert;
}

// Manual resolve — from active or acknowledged. If never acknowledged, stamp the
// resolver as the handler so the audit trail isn't blank.
async function resolve(id, userId) {
  const [res] = await db.query(
    `UPDATE alerts
        SET status = 'resolved', resolved_at = NOW(),
            acknowledged_by = COALESCE(acknowledged_by, ?),
            acknowledged_at = COALESCE(acknowledged_at, NOW())
      WHERE alert_id = ? AND status <> 'resolved'`,
    [userId, Number(id)],
  );
  // The actor has clearly seen it → mark their own bell row read (only theirs).
  await notificationService.markReadByAlert(userId, id);
  const alert = await getById(id);
  if (res.affectedRows) {
    // Re-arm the detector so a still-breaching metric re-alerts on the next reading
    // (a manual resolve of a condition that's still true should re-fire, not go silent).
    if (alert) alertBandState.resetBand(alert.deviceId, alert.type);
    broadcast(alert);
  }
  return alert;
}

// Auto-resolve every open (active/acknowledged) alert for a device+metric once the
// metric recovers to normal. Leaves acknowledged_by as-is (a system close, not a
// human one). deviceId may be NULL (room-level environment alerts).
async function autoResolveMetric(deviceId, type) {
  const dId = deviceId ?? null;
  const [open] = await db.query(
    `SELECT alert_id FROM alerts
      WHERE device_id <=> ? AND type = ? AND status <> 'resolved'`,
    [dId, type],
  );
  if (!open.length) return 0;
  await db.query(
    `UPDATE alerts SET status = 'resolved', resolved_at = NOW()
      WHERE device_id <=> ? AND type = ? AND status <> 'resolved'`,
    [dId, type],
  );
  // Re-arm the detector (matches the manual-resolve path; harmless on the recovery
  // path since the trigger already set this band back to normal).
  alertBandState.resetBand(dId, type);
  for (const r of open) broadcast(await getById(r.alert_id));
  return open.length;
}

export default { init, list, getById, openCount, acknowledge, resolve, autoResolveMetric };
