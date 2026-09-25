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

// Alert history, newest first. Optional filters:
//   status  active | acknowledged | resolved, or "open" = anything not yet resolved
//   device  one device's alerts only — what a server's detail page asks for
async function list({ status, limit = 100, device } = {}) {
  const n = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const where = [];
  const params = [];
  if (status === "open") {
    where.push("a.status <> 'resolved'");
  } else if (status && VALID_STATUS.includes(status)) {
    where.push("a.status = ?");
    params.push(status);
  }
  const dev = Number.parseInt(device, 10);
  if (Number.isInteger(dev) && dev > 0) {
    where.push("a.device_id = ?");
    params.push(dev);
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
//
// `above` narrows it to the severities that outrank a band: a metric that falls from
// critical to warning closes its CRITICAL alert and leaves any WARNING alert open,
// because the warning condition is still true.
async function autoResolveMetric(deviceId, type, { above = null } = {}) {
  const dId = deviceId ?? null;
  const partial = above && above !== alertBandState.DEFAULT_BAND;
  const sevs = partial ? alertBandState.severitiesAbove(above) : null;
  if (partial && !sevs.length) return 0;
  const sevSql = partial ? ` AND severity IN (${sevs.map(() => "?").join(",")})` : "";
  const params = partial ? [dId, type, ...sevs] : [dId, type];

  const [open] = await db.query(
    `SELECT alert_id FROM alerts
      WHERE device_id <=> ? AND type = ? AND status <> 'resolved'${sevSql}`,
    params,
  );
  if (!open.length) return 0;
  await db.query(
    `UPDATE alerts SET status = 'resolved', resolved_at = NOW()
      WHERE device_id <=> ? AND type = ? AND status <> 'resolved'${sevSql}`,
    params,
  );
  // Re-arm the detector (matches the manual-resolve path; harmless on the recovery
  // path since the trigger already set this band back to normal). NOT on a partial
  // close: the metric is still in a band, and the caller is about to record it.
  if (!partial) alertBandState.resetBand(dId, type);
  for (const r of open) broadcast(await getById(r.alert_id));
  return open.length;
}

// One reading's band transition, shared by every threshold trigger (servers,
// routers/UPS/MikroTik, the room environment). Applies recovery confirmation, closes
// whatever a confirmed drop has made untrue, and records the band.
//
// Returns { effective, downgraded, dropped }. `dropped` is the band a CONFIRMED drop
// landed in ("normal" = full recovery), else null — callers write it to the device's
// event log so the history shows a problem ending, not only starting.
// `downgraded` is true when a confirmed drop landed
// in a band that still has no open alert — e.g. memory went straight to critical (so no
// warning alert was ever raised), then settled at 88%. The caller raises the lower-band
// alert in that case, so the incident list keeps saying the metric is still elevated
// instead of going quiet the moment the critical alert closes.
async function settleBand(deviceId, type, prevBand, band) {
  const { effective, resolveAbove } = alertBandState.settle(deviceId, type, prevBand, band);
  let downgraded = false;
  if (resolveAbove) {
    await autoResolveMetric(deviceId, type, { above: resolveAbove });
    if (resolveAbove !== alertBandState.DEFAULT_BAND) {
      const [[open]] = await db.query(
        `SELECT alert_id FROM alerts
          WHERE device_id <=> ? AND type = ? AND severity = ? AND status <> 'resolved' LIMIT 1`,
        [deviceId ?? null, type, resolveAbove],
      );
      downgraded = !open;
    }
  }
  alertBandState.setBand(deviceId, type, effective);
  return { effective, downgraded, dropped: resolveAbove };
}

// Rebuild the in-memory bands from the alerts that are actually OPEN.
//
// The bands live in memory, and they used to start from "normal" after a backend
// restart and after a server's offline flip (alertBandState.resetDevice). An alert left
// open across either could then never auto-resolve: the next normal reading looked
// like normal → normal, which is no transition at all. That is how a Memory critical
// alert from the day before was still open. Seeding the band from the open alert makes
// the next normal reading a real recovery, which closes it through the usual path.
//
// deviceId undefined = every device (startup); a number or null = that one device.
async function seedBands(deviceId) {
  const one = deviceId !== undefined;
  const [rows] = await db.query(
    `SELECT device_id, type, severity FROM alerts
      WHERE status <> 'resolved'${one ? " AND device_id <=> ?" : ""}`,
    one ? [deviceId ?? null] : [],
  );
  const worst = new Map();
  for (const r of rows) {
    const k = `${r.device_id ?? "room"}|${r.type}`;
    const prev = worst.get(k);
    worst.set(k, { dev: r.device_id, type: r.type,
      sev: prev ? alertBandState.worse(prev.sev, r.severity) : r.severity });
  }
  for (const { dev, type, sev } of worst.values()) {
    alertBandState.setBand(dev, type, alertBandState.worse(alertBandState.getBand(dev, type), sev));
  }
  return worst.size;
}

export default { init, list, getById, openCount, acknowledge, resolve, autoResolveMetric, settleBand, seedBands };
