import "../config/env.js";
import db from "../config/mysql.js";
import emailService from "./emailService.js";

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
const SEV_RANK = { info: 0, warning: 1, critical: 2 };

function normalizeSeverity(s) {
  const v = String(s ?? "").toLowerCase();
  return SEVERITIES.includes(v) ? v : null;
}

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
    const dId = deviceId ?? null;

    // Cooldown / de-dup (restart-proof): skip if an identical alert (same device +
    // type + severity) was already raised within the window. Stops the bell + email
    // repeating for a value that stays in-band across polls AND across backend
    // restarts (the in-memory hysteresis can't survive a restart; this DB check can).
    // `<=>` is MySQL's null-safe equals, since device_id may be NULL (system alerts).
    const cooldownMin = Number(process.env.NOTIFY_COOLDOWN_MIN) || 30;
    const [[recent]] = await db.query(
      `SELECT alert_id FROM alerts
        WHERE device_id <=> ? AND type = ? AND severity = ?
          AND created_at > (NOW() - INTERVAL ? MINUTE)
        ORDER BY alert_id DESC LIMIT 1`,
      [dId, type, severity, cooldownMin],
    );
    if (recent) return recent.alert_id;

    // 1) the event
    const [ins] = await db.query(
      `INSERT INTO alerts (device_id, metric_value, type, title, message, severity, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [dId, metricValue, type, title, message, severity],
    );
    const alertId = ins.insertId;

    // 2) recipients — every active user, with their email + email preferences
    //    (a missing notification_prefs row falls back to defaults: enabled, and the
    //    env-configured minimum severity).
    const emailMinDefault = normalizeSeverity(process.env.NOTIFY_EMAIL_MIN_SEVERITY) || "critical";
    const [users] = await db.query(
      `SELECT u.user_id, u.email,
              COALESCE(p.email_enabled, 1)              AS email_enabled,
              COALESCE(p.min_email_severity, ?)         AS min_email_severity
         FROM users u
         LEFT JOIN notification_prefs p ON p.user_id = u.user_id
        WHERE u.status = 'active'`,
      [emailMinDefault],
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

    // 5) email channel — severity-gated, per-user pref. Only when Resend is
    //    configured. Concurrent + best-effort: an email failure never affects the
    //    bell/toast that already fired. Mark emailed=1 so a re-run never re-sends.
    if (emailService.isEnabled()) {
      const byUser = new Map(users.map((u) => [u.user_id, u]));
      await Promise.allSettled(
        rows.map(async (r) => {
          const u = byUser.get(r.user_id);
          if (!u || !u.email || !Number(u.email_enabled)) return;
          if (SEV_RANK[severity] < (SEV_RANK[u.min_email_severity] ?? 2)) return;
          const ok = await emailService.sendAlertEmail(u.email, {
            title, message, severity, deviceName: r.device_name ?? null, createdAt: r.created_at,
          });
          if (ok) await db.query(`UPDATE alert_notifications SET emailed = 1 WHERE id = ?`, [r.id]);
        }),
      );
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
