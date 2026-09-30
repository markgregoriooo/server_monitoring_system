import "../config/env.js";
import db from "../config/mysql.js";
import emailService from "./emailService.js";
import { describeError } from "../utils/httpError.js";

// Notifications (the bell feed). One `alerts` row is the event, copied into one
// `alert_notifications` row per active user (per-user read state). raiseAlert()
// saves it and pushes it live to everyone. `io` is set once in init().

let _io = null;
export function init(io) {
  _io = io;
}

const SEVERITIES = ["info", "warning", "critical"];
const SEV_RANK = { info: 0, warning: 1, critical: 2 };

// Defaults for a user who has never changed their settings. Used by the recipient
// query, getPrefs() and userService.registerGoogleUser.
//
// Alert email is opt-in (`emailEnabled: false`): email is the only channel that
// reaches someone who has never signed in or seen the Privacy Notice (RA 10173).
// Users turn it on in Settings → Notification preferences.
// migrations/2026-09-18_notification_prefs_default_off.sql kept email on for
// everyone who had already signed in.
export const PREF_DEFAULTS = { emailEnabled: false, popupEnabled: true };

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
    // A server has a display name ("Main DB server") and a hostname, and an alert
    // should show both. Display name first, using the same COALESCE as the rest of
    // the app, so a renamed device reads the same everywhere.
    deviceName: (r.display_name ?? "").trim() || r.device_name || null,
    // The hostname too, only when it differs, so it never reads "web-01 (web-01)".
    deviceHostname:
      (r.display_name ?? "").trim() && r.display_name.trim() !== r.device_name
        ? r.device_name
        : null,
    // The device type (server|router|mikrotik|ups|esp32|aircon). The client uses it to
    // open the right page, since routers, UPS and MikroTiks share alert types such as
    // `device_offline`.
    deviceType: r.device_type ?? null,
    type: r.type,
    title: r.title,
    message: r.message,
    severity: r.severity,
    isRead: Boolean(r.is_read),
    createdAt: iso(r.created_at),
    sentAt: iso(r.sent_at),
    // Shared lifecycle state so the bell can show acknowledge/resolve (distinct from
    // the per-user is_read). Kept in sync live via the `alertUpdated` broadcast.
    status: r.status ?? "active",
    acknowledgedByName: r.acknowledged_by_name ?? null,
    acknowledgedByRole: r.acknowledged_by_role ?? null,
    acknowledgedAt: iso(r.acknowledged_at),
    resolvedAt: iso(r.resolved_at),
  };
}

// Raise one alert and send it to every active user. Best-effort: errors are
// swallowed so monitoring never breaks. Returns the new alert_id or null.
async function raiseAlert({ deviceId, type, title, message, severity = "info", metricValue = null, alertRuleId = null, cooldownMin = null }) {
  try {
    if (!SEVERITIES.includes(severity)) severity = "info";
    const dId = deviceId ?? null;

    // De-dup: skip if an identical alert (device + type + severity) is still open and
    // was raised within the window. Stored in the DB, so it survives restarts. A
    // resolved alert no longer blocks, so a real recurrence alerts right away. `<=>` is
    // the null-safe equals, since device_id may be NULL. Callers can pass a longer
    // window (forecast alerts use days, not 30 minutes).
    const cooldown = Number(cooldownMin) || Number(process.env.NOTIFY_COOLDOWN_MIN) || 30;
    const [[recent]] = await db.query(
      `SELECT alert_id FROM alerts
        WHERE device_id <=> ? AND type = ? AND severity = ?
          AND status <> 'resolved'
          AND created_at > (NOW() - INTERVAL ? MINUTE)
        ORDER BY alert_id DESC LIMIT 1`,
      [dId, type, severity, cooldown],
    );
    if (recent) return recent.alert_id;

    // 1) the event — alert_rule_id records WHICH configurable rule fired (NULL for
    //    triggers that aren't rule-based, e.g. server offline).
    const [ins] = await db.query(
      `INSERT INTO alerts (device_id, alert_rule_id, metric_value, type, title, message, severity, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      [dId, alertRuleId ?? null, metricValue, type, title, message, severity],
    );
    const alertId = ins.insertId;

    // 2) Recipients: every active user with their email preferences. Users with no
    //    notification_prefs row use PREF_DEFAULTS (feed and live push yes, email no).
    //    Passed as a parameter so the default lives in one place.
    const emailMinDefault = normalizeSeverity(process.env.NOTIFY_EMAIL_MIN_SEVERITY) || "critical";
    const [users] = await db.query(
      `SELECT u.user_id, u.email,
              COALESCE(p.email_enabled, ?)              AS email_enabled,
              COALESCE(p.min_email_severity, ?)         AS min_email_severity
         FROM users u
         LEFT JOIN notification_prefs p ON p.user_id = u.user_id
        WHERE u.status = 'active'`,
      [PREF_DEFAULTS.emailEnabled ? 1 : 0, emailMinDefault],
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
              a.status, a.acknowledged_at, a.resolved_at,
              d.device_name, d.display_name, d.device_type,
              u.name AS acknowledged_by_name, u.role AS acknowledged_by_role
         FROM alert_notifications n
         JOIN alerts a   ON a.alert_id = n.alert_id
         LEFT JOIN devices d ON d.device_id = a.device_id
         LEFT JOIN users u   ON u.user_id   = a.acknowledged_by
        WHERE n.alert_id = ?`,
      [alertId],
    );
    if (_io) {
      for (const r of rows) {
        _io.to(`user:${r.user_id}`).emit("notification", toClient(r));
      }
    } else {
      // init(io) should have been called at startup (src/server.js). Log it, because
      // otherwise the bell, toast and popup silently stop while email still goes out.
      // See audits/design-patterns-report-2026-08-25.md (P-09).
      console.error(
        `[notify] alert ${alertId}: raiseAlert() ran before init(io) — ` +
          `${rows.length} in-app notification(s) dropped (row + email unaffected)`,
      );
    }

    // 5) Email: by severity and per-user preference, only when SMTP is configured.
    //    Sent in parallel and best-effort. emailed=1 so it is never sent twice.
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
    console.error("[notifications] raiseAlert error:", describeError(err));
    return null;
  }
}

// The bell feed for one user, newest first.
async function listForUser(userId, { limit = 30 } = {}) {
  const n = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const [rows] = await db.query(
    `SELECT n.id, n.is_read, n.sent_at,
            a.alert_id, a.device_id, a.type, a.title, a.message, a.severity, a.created_at,
            a.status, a.acknowledged_at, a.resolved_at,
            d.device_name, d.display_name, d.device_type,
            u.name AS acknowledged_by_name, u.role AS acknowledged_by_role
       FROM alert_notifications n
       JOIN alerts a   ON a.alert_id = n.alert_id
       LEFT JOIN devices d ON d.device_id = a.device_id
       LEFT JOIN users u   ON u.user_id   = a.acknowledged_by
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

// Mark this user's bell entry for one alert as read (used when they acknowledge or
// resolve it). Only this user's row.
async function markReadByAlert(userId, alertId) {
  if (!userId || !alertId) return 0;
  const [res] = await db.query(
    `UPDATE alert_notifications SET is_read = 1, read_at = NOW()
      WHERE user_id = ? AND alert_id = ? AND is_read = 0`,
    [userId, Number(alertId)],
  );
  return res.affectedRows;
}

// Remove feed rows (delete, not just read) — scoped to the caller. The underlying
// `alerts` event stays (other users keep their copy; retention handles history).
async function dismiss(userId, ids) {
  const clean = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  if (!clean.length) return 0;
  const [res] = await db.query(
    `DELETE FROM alert_notifications WHERE user_id = ? AND id IN (?)`,
    [userId, clean],
  );
  return res.affectedRows;
}

async function clearAll(userId) {
  const [res] = await db.query(`DELETE FROM alert_notifications WHERE user_id = ?`, [userId]);
  return res.affectedRows;
}

// ─── Per-user preferences (notification_prefs) ─────────────────────────────────
// A missing row = PREF_DEFAULTS (email OFF, popups on) + the env minimum severity.

function defaultMinSeverity() {
  return normalizeSeverity(process.env.NOTIFY_EMAIL_MIN_SEVERITY) || "critical";
}

async function getPrefs(userId) {
  const [[row]] = await db.query(
    `SELECT email_enabled, popup_enabled, min_email_severity
       FROM notification_prefs WHERE user_id = ?`,
    [userId],
  );
  return {
    emailEnabled: row ? Boolean(row.email_enabled) : PREF_DEFAULTS.emailEnabled,
    popupEnabled: row ? Boolean(row.popup_enabled) : PREF_DEFAULTS.popupEnabled,
    minEmailSeverity: row?.min_email_severity ?? defaultMinSeverity(),
  };
}

// Upsert; accepts a partial patch and preserves untouched fields.
async function savePrefs(userId, patch = {}) {
  const cur = await getPrefs(userId);
  const next = {
    emailEnabled: patch.emailEnabled ?? cur.emailEnabled,
    popupEnabled: patch.popupEnabled ?? cur.popupEnabled,
    minEmailSeverity: normalizeSeverity(patch.minEmailSeverity) ?? cur.minEmailSeverity,
  };
  await db.query(
    `INSERT INTO notification_prefs (user_id, email_enabled, popup_enabled, min_email_severity)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE email_enabled = VALUES(email_enabled),
                             popup_enabled = VALUES(popup_enabled),
                             min_email_severity = VALUES(min_email_severity)`,
    [userId, next.emailEnabled ? 1 : 0, next.popupEnabled ? 1 : 0, next.minEmailSeverity],
  );
  return next;
}

// Retention: delete alerts older than `days`; alert_notifications cascade (FK).
async function purgeOld(days) {
  const n = Number(days) || 30;
  const [res] = await db.query(
    `DELETE FROM alerts WHERE created_at < (NOW() - INTERVAL ? DAY)`,
    [n],
  );
  return res.affectedRows;
}

export default {
  init, raiseAlert, listForUser, unreadCount, markRead, markAllRead, markReadByAlert,
  dismiss, clearAll, getPrefs, savePrefs, purgeOld,
};
