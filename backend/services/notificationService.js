import "../config/env.js";
import db from "../config/mysql.js";

// Notifications = the bell feed. One `alerts` row is the EVENT; we fan it out to
// one `alert_notifications` row PER active user (the per-user read state + feed).
// A single raiseAlert() therefore both persists and live-pushes to every recipient.
//
// `io` is injected once at startup (init) so trigger sites — the offline sweep,
// threshold checks, future UPS/router events — can raise an alert without
// threading the Socket.IO server through every call.

let _io = null;
export function init(io) {
  _io = io;
}

const SEVERITIES = ["info", "warning", "critical"];

// DB row (snake_case, from the alerts ⨝ alert_notifications join) → client payload (camelCase).
function toClient(r) {
  const iso = (v) => (v instanceof Date ? v.toISOString() : v);
  return {
    id: r.id, // alert_notifications.id — the per-user row the client marks read
    alertId: r.alert_id,
    deviceId: r.device_id,
    deviceName: r.device_name ?? null,
    type: r.type,
    title: r.title,
    message: r.message,
    severity: r.severity,
    isRead: Boolean(r.is_read),
    createdAt: iso(r.created_at),
    sentAt: iso(r.sent_at),
  };
}

// Raise one alert and fan it out to every active user. Best-effort: a notification
// failure must never break the monitoring path that triggered it, so this swallows
// errors and returns the new alert_id (or null on failure).
async function raiseAlert({ deviceId, type, title, message, severity = "info", metricValue = null }) {
  try {
    if (!SEVERITIES.includes(severity)) severity = "info";

    // 1) the event
    const [ins] = await db.query(
      `INSERT INTO alerts (device_id, metric_value, type, title, message, severity, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [deviceId, metricValue, type, title, message, severity],
    );
    const alertId = ins.insertId;

    // 2) recipients — every active user
    const [users] = await db.query(
      `SELECT user_id FROM users WHERE status = 'active'`,
    );
    if (!users.length) return alertId;

    // 3) fan out — one feed row per recipient (is_read/emailed default to 0)
    await db.query(
      `INSERT INTO alert_notifications (alert_id, user_id) VALUES ?`,
      [users.map((u) => [alertId, u.user_id])],
    );

    // 4) live push to each recipient's room, carrying that user's own row id
    const [rows] = await db.query(
      `SELECT n.id, n.user_id, n.is_read, n.sent_at,
              a.alert_id, a.device_id, a.type, a.title, a.message, a.severity, a.created_at,
              d.device_name
         FROM alert_notifications n
         JOIN alerts a   ON a.alert_id = n.alert_id
         LEFT JOIN devices d ON d.device_id = a.device_id
        WHERE n.alert_id = ?`,
      [alertId],
    );
    if (_io) {
      for (const r of rows) {
        _io.to(`user:${r.user_id}`).emit("notification", toClient(r));
      }
    }
    return alertId;
  } catch (err) {
    console.error("[notifications] raiseAlert error:", err.message);
    return null;
  }
}

// The bell feed for one user, newest first.
async function listForUser(userId, { limit = 30 } = {}) {
  const n = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const [rows] = await db.query(
    `SELECT n.id, n.is_read, n.sent_at,
            a.alert_id, a.device_id, a.type, a.title, a.message, a.severity, a.created_at,
            d.device_name
       FROM alert_notifications n
       JOIN alerts a   ON a.alert_id = n.alert_id
       LEFT JOIN devices d ON d.device_id = a.device_id
      WHERE n.user_id = ?
      ORDER BY n.sent_at DESC, n.id DESC
      LIMIT ${n}`,
    [userId],
  );
  return rows.map(toClient);
}

async function unreadCount(userId) {
  const [[row]] = await db.query(
    `SELECT COUNT(*) AS c FROM alert_notifications WHERE user_id = ? AND is_read = 0`,
    [userId],
  );
  return Number(row?.c ?? 0);
}

// Mark specific feed rows read — scoped to the caller so one user can't touch another's.
async function markRead(userId, ids) {
  const clean = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  if (!clean.length) return 0;
  const [res] = await db.query(
    `UPDATE alert_notifications SET is_read = 1, read_at = NOW()
      WHERE user_id = ? AND is_read = 0 AND id IN (?)`,
    [userId, clean],
  );
  return res.affectedRows;
}

async function markAllRead(userId) {
  const [res] = await db.query(
    `UPDATE alert_notifications SET is_read = 1, read_at = NOW()
      WHERE user_id = ? AND is_read = 0`,
    [userId],
  );
  return res.affectedRows;
}

export default { init, raiseAlert, listForUser, unreadCount, markRead, markAllRead };
