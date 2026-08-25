import "../config/env.js";
import db from "../config/mysql.js";
import emailService from "./emailService.js";
import { describeError } from "../utils/httpError.js";

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
    // The devices row's kind (server|router|mikrotik|ups|esp32|aircon). The client
    // needs it to know WHICH page a notification belongs to: deviceAlerts.checkRouter
    // is shared by the SNMP and MikroTik pollers, so both stamp `router_*`/`link_*`,
    // and routers, UPS and MikroTiks all raise the same `device_offline`. The alert
    // type alone therefore can't tell those pages apart — this is what does.
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

// Raise one alert and fan it out to every active user. Best-effort: a notification
// failure must never break the monitoring path that triggered it, so this swallows
// errors and returns the new alert_id (or null on failure).
async function raiseAlert({ deviceId, type, title, message, severity = "info", metricValue = null, alertRuleId = null, cooldownMin = null }) {
  try {
    if (!SEVERITIES.includes(severity)) severity = "info";
    const dId = deviceId ?? null;

    // Cooldown / de-dup (restart-proof): skip if an identical alert (same device +
    // type + severity) is still OPEN and was raised within the window. Stops the bell +
    // email repeating for a value that stays in-band across polls AND across backend
    // restarts (the in-memory hysteresis can't survive a restart; this DB check can).
    //
    // `status <> 'resolved'` is the key: once an alert is resolved (manually or
    // auto-resolved when the metric recovered), it no longer suppresses — so a genuine
    // RECURRENCE re-alerts immediately instead of waiting out the window. This matches
    // how real incident tools de-dup (per open incident, not a blind wall clock).
    // `<=>` is MySQL's null-safe equals, since device_id may be NULL (system alerts).
    // Callers may override the window. A live metric flapping around its threshold wants
    // the short default; a FORECAST ("disk full in ~6 days") moves on a scale of days, so
    // re-announcing it every 30 minutes would be noise — analyticsAlerts passes a much
    // longer window. Auto-resolve on recovery still works either way, since the de-dup is
    // scoped to alerts that are still open.
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
              a.status, a.acknowledged_at, a.resolved_at,
              d.device_name, d.device_type,
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
      // init(io) is called once at startup (src/server.js). Reaching here means the
      // wiring is broken, and the old `if (_io)` swallowed that silently — the alert row
      // and the email still go out, but no bell, no toast, no OS popup, with nothing in
      // the log to say why. A dropped ALERT is the most expensive silent failure in this
      // system, so it says so. See audits/design-patterns-report-2026-08-25.md — P-09.
      console.error(
        `[notify] alert ${alertId}: raiseAlert() ran before init(io) — ` +
          `${rows.length} in-app notification(s) dropped (row + email unaffected)`,
      );
    }

    // 5) email channel — severity-gated, per-user pref. Only when SMTP is
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
            d.device_name, d.device_type,
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

// Mark THIS user's bell row for a specific alert read — used when they acknowledge or
// resolve that alert (acting on it means they've seen it). Scoped to the one user;
// never touches anyone else's read state.
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
// A missing row = defaults (email on, popups on, min severity from env).

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
    emailEnabled: row ? Boolean(row.email_enabled) : true,
    popupEnabled: row ? Boolean(row.popup_enabled) : true,
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
